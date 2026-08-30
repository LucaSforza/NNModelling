import type { ModelBundleResources } from "../type-system/editor-runtime"

export type FileSystemPermissionMode = "read" | "readwrite"

/** The small subset of the File System Access API used by project workspaces. */
export interface ProjectFileHandle {
  readonly kind?: "file"
  readonly name?: string
  getFile(): Promise<ProjectFile>
  createWritable(): Promise<ProjectWritableFile>
}

export interface ProjectFile {
  text?(): Promise<string>
  arrayBuffer?(): Promise<ArrayBuffer>
}

export interface ProjectWritableFile {
  write(data: string | Uint8Array): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}

export interface ProjectDirectoryHandle {
  readonly kind?: "directory"
  readonly name?: string
  getDirectoryHandle(name: string, options?: { readonly create?: boolean }): Promise<ProjectDirectoryHandle>
  getFileHandle(name: string, options?: { readonly create?: boolean }): Promise<ProjectFileHandle>
  entries?(): AsyncIterable<[string, ProjectDirectoryHandle | ProjectFileHandle]>
  values?(): AsyncIterable<ProjectDirectoryHandle | ProjectFileHandle>
  queryPermission?(options: { readonly mode: FileSystemPermissionMode }): Promise<PermissionState>
  requestPermission?(options: { readonly mode: FileSystemPermissionMode }): Promise<PermissionState>
  removeEntry?(name: string, options?: { readonly recursive?: boolean }): Promise<void>
}

export type ProjectDirectoryPicker = (options: {
  readonly mode: "readwrite"
}) => Promise<ProjectDirectoryHandle>

/** Injectable browser boundary used by startup and by in-memory tests. */
export class ProjectWorkspaceAdapter {
  constructor(private readonly picker: ProjectDirectoryPicker = browserProjectDirectoryPicker()) {}

  selectParent(): Promise<ProjectDirectoryHandle> {
    return selectProjectParent(this.picker)
  }

  create(projectId: string, modelJson: string): Promise<ProjectWorkspaceSession> {
    return this.selectParent().then((parent) => createProjectWorkspace(parent, projectId, modelJson))
  }

  open(): Promise<ProjectWorkspaceSession> {
    return selectExistingProject(this.picker)
  }

  newProject(projectId: string, modelJson: string): Promise<ProjectWorkspaceSession> {
    return this.create(projectId, modelJson)
  }

  openProject(): Promise<ProjectWorkspaceSession> {
    return this.open()
  }

  openDirectory(directory: ProjectDirectoryHandle): Promise<ProjectWorkspaceSession> {
    return openProjectWorkspace(directory)
  }
}

export type ProjectResourceSet = {
  readonly modelJson: string
  readonly resources: ModelBundleResources
}

export class ProjectWorkspaceError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = new.target.name
  }
}

export class UnsupportedProjectFilesystemError extends ProjectWorkspaceError {
  constructor() { super("The browser does not support writable project directories", "unsupported") }
}

export class ProjectSelectionCancelledError extends ProjectWorkspaceError {
  constructor() { super("Project directory selection was cancelled", "cancelled") }
}

export class ProjectPermissionDeniedError extends ProjectWorkspaceError {
  constructor() { super("Permission to access the project directory was denied", "permission-denied") }
}

export class ProjectCollisionError extends ProjectWorkspaceError {
  constructor(readonly projectId: string) { super(`Project directory '${projectId}' already exists`, "collision") }
}

export class InvalidProjectPathError extends ProjectWorkspaceError {
  constructor(path: string) { super(`Project path '${path}' must be relative to the project root`, "invalid-path") }
}

export class ProjectWriteError extends ProjectWorkspaceError {
  constructor(readonly path: string, cause: unknown) {
    super(`Unable to write project file '${path}': ${cause instanceof Error ? cause.message : String(cause)}`, "write-failed")
  }
}

export type ProjectSaveState = "idle" | "pending" | "saved" | "failed"

export type ProjectSaveStatus = {
  readonly state: ProjectSaveState
  readonly pending: number
  readonly latestAcceptedVersion: number
  readonly latestSavedVersion?: number
  readonly error?: unknown
}

export type ProjectSaveResult = {
  readonly version: number
  readonly state: "saved"
}

type SaveListener = (status: ProjectSaveStatus) => void

/** Serializes model saves so an older, delayed write cannot replace a newer one. */
export class ProjectModelWriter {
  private tail: Promise<void> = Promise.resolve()
  private acceptedVersion = 0
  private savedVersion: number | undefined
  private pendingCount = 0
  private currentState: ProjectSaveState = "idle"
  private currentError: unknown
  private readonly listeners = new Set<SaveListener>()

  constructor(private readonly writeModel: (modelJson: string) => Promise<void>) {}

  get status(): ProjectSaveStatus {
    return {
      state: this.currentState,
      pending: this.pendingCount,
      latestAcceptedVersion: this.acceptedVersion,
      ...(this.savedVersion === undefined ? {} : { latestSavedVersion: this.savedVersion }),
      ...(this.currentError === undefined ? {} : { error: this.currentError }),
    }
  }

  subscribe(listener: SaveListener): () => void {
    this.listeners.add(listener)
    listener(this.status)
    return () => this.listeners.delete(listener)
  }

  save(modelJson: string): Promise<ProjectSaveResult> {
    const version = ++this.acceptedVersion
    this.pendingCount += 1
    this.currentState = "pending"
    this.currentError = undefined
    this.notify()

    const operation = this.tail.then(async () => {
      try {
        await this.writeModel(modelJson)
        this.savedVersion = version
        this.currentError = undefined
        return { version, state: "saved" as const }
      } catch (cause) {
        if (version === this.acceptedVersion) this.currentError = cause
        throw cause
      } finally {
        this.pendingCount -= 1
        this.currentState = this.pendingCount === 0
          ? (this.currentError === undefined ? "saved" : "failed")
          : "pending"
        this.notify()
      }
    })
    // Keep the queue alive after one failed save; each caller still observes
    // its own rejection while later accepted states continue to be persisted.
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private notify(): void {
    const status = this.status
    for (const listener of this.listeners) listener(status)
  }
}

export interface ProjectWorkspaceSession extends ProjectResourceSet {
  /** Session-only capability; never include this object in model JSON. */
  readonly directory: ProjectDirectoryHandle
  readonly writer: ProjectModelWriter
  readonly save: (modelJson: string) => Promise<ProjectSaveResult>
  readonly rollback: () => Promise<void>
}

export type CreateProjectResult = ProjectWorkspaceSession

const PROJECT_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/

export function normalizeProjectPath(path: string): string {
  if (typeof path !== "string") throw new InvalidProjectPathError(String(path))
  const normalized = path.replaceAll("\\", "/")
  const segments = normalized.split("/")
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.includes("\0") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new InvalidProjectPathError(path)
  }
  return normalized
}

export function browserProjectDirectoryPicker(): ProjectDirectoryPicker {
  const picker = (globalThis as typeof globalThis & {
    showDirectoryPicker?: ProjectDirectoryPicker
  }).showDirectoryPicker
  if (typeof picker !== "function") throw new UnsupportedProjectFilesystemError()
  return (options) => Promise.resolve().then(() => picker(options)).catch((cause) => {
    if (isAbortError(cause)) throw new ProjectSelectionCancelledError()
    throw cause
  })
}

export async function selectProjectParent(picker = browserProjectDirectoryPicker()): Promise<ProjectDirectoryHandle> {
  const parent = await selectDirectory(picker)
  await ensureProjectPermission(parent)
  return parent
}

export async function selectExistingProject(picker = browserProjectDirectoryPicker()): Promise<ProjectWorkspaceSession> {
  const directory = await selectDirectory(picker)
  return openProjectWorkspace(directory)
}

async function selectDirectory(picker: ProjectDirectoryPicker): Promise<ProjectDirectoryHandle> {
  try {
    return await picker({ mode: "readwrite" })
  } catch (cause) {
    if (isAbortError(cause)) throw new ProjectSelectionCancelledError()
    throw cause
  }
}

export async function ensureProjectPermission(directory: ProjectDirectoryHandle, mode: FileSystemPermissionMode = "readwrite"): Promise<void> {
  if (!directory.queryPermission && !directory.requestPermission) return
  let permission = await directory.queryPermission?.({ mode })
  if (permission !== "granted") permission = await directory.requestPermission?.({ mode })
  if (permission !== undefined && permission !== "granted") throw new ProjectPermissionDeniedError()
}

export async function createProjectWorkspace(
  parent: ProjectDirectoryHandle,
  projectId: string,
  modelJson: string,
): Promise<CreateProjectResult> {
  validateProjectId(projectId)
  await ensureProjectPermission(parent)

  let existing: ProjectDirectoryHandle | undefined
  try {
    existing = await parent.getDirectoryHandle(projectId)
  } catch (cause) {
    if (!isNotFoundError(cause)) throw cause
  }
  if (existing) throw new ProjectCollisionError(projectId)

  const directory = await parent.getDirectoryHandle(projectId, { create: true })
  let created = true
  try {
    await writeProjectFiles(directory, { "model.json": modelJson })
    const session = await makeSession(directory, parent, projectId, created)
    // The initial model is already on disk; the writer starts at version zero.
    return session
  } catch (cause) {
    if (created) await rollbackCreatedDirectory(parent, projectId, directory)
    throw cause
  }
}

export async function openProjectWorkspace(directory: ProjectDirectoryHandle): Promise<ProjectWorkspaceSession> {
  await ensureProjectPermission(directory)
  const resources = await readProjectWorkspace(directory)
  return makeSession(directory, undefined, directory.name, false, resources)
}

export const createProject = createProjectWorkspace
export const openProject = openProjectWorkspace

export async function readProjectWorkspace(directory: ProjectDirectoryHandle): Promise<ProjectResourceSet> {
  await ensureProjectPermission(directory, "read")
  const resources: Record<string, string | Uint8Array> = {}
  await readDirectory(directory, "", resources)
  let modelJson = resources["model.json"]
  if (modelJson === undefined) throw new Error("Project directory does not contain model.json")
  if (typeof modelJson !== "string") modelJson = new TextDecoder().decode(modelJson)
  return { modelJson, resources }
}

export async function writeProjectFiles(
  directory: ProjectDirectoryHandle,
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<void> {
  const normalized = new Map<string, string | Uint8Array>()
  for (const [path, value] of Object.entries(files)) {
    const safePath = normalizeProjectPath(path)
    if (normalized.has(safePath)) throw new InvalidProjectPathError(path)
    normalized.set(safePath, value)
  }
  for (const [path, value] of normalized) await writeProjectFile(directory, path, value)
}

async function makeSession(
  directory: ProjectDirectoryHandle,
  parent?: ProjectDirectoryHandle,
  projectId?: string,
  created = false,
  loaded?: ProjectResourceSet,
): Promise<ProjectWorkspaceSession> {
  const resources = loaded ?? await readProjectWorkspace(directory)
  const writer = new ProjectModelWriter(async (modelJson) => writeProjectFiles(directory, { "model.json": modelJson }))
  let rollbackCompleted = false
  return {
    ...resources,
    directory,
    writer,
    save: (modelJson) => writer.save(modelJson),
    rollback: async () => {
      if (rollbackCompleted || !created || !parent || !projectId) throw new Error("Only a directory created by this operation can be rolled back")
      await rollbackCreatedDirectory(parent, projectId, directory)
      rollbackCompleted = true
    },
  }
}

async function readDirectory(
  directory: ProjectDirectoryHandle,
  prefix: string,
  resources: Record<string, string | Uint8Array>,
): Promise<void> {
  const entries = directory.entries ? directory.entries() : directory.values ? toNamedEntries(directory.values()) : undefined
  if (!entries) throw new Error("Directory handle does not support recursive enumeration")
  for await (const [name, handle] of entries) {
    const path = normalizeProjectPath(prefix ? `${prefix}/${name}` : name)
    if (isDirectoryHandle(handle)) {
      await readDirectory(handle, path, resources)
    } else {
      resources[path] = await readProjectFile(handle as ProjectFileHandle)
    }
  }
}

function isDirectoryHandle(handle: ProjectDirectoryHandle | ProjectFileHandle): handle is ProjectDirectoryHandle {
  return handle.kind === "directory" || (handle.kind === undefined && ("entries" in handle || "values" in handle))
}

async function* toNamedEntries(values: AsyncIterable<ProjectDirectoryHandle | ProjectFileHandle>): AsyncIterable<[string, ProjectDirectoryHandle | ProjectFileHandle]> {
  for await (const handle of values) {
    if (!handle.name) throw new Error("File system entry has no name")
    yield [handle.name, handle]
  }
}

async function readProjectFile(handle: ProjectFileHandle): Promise<string | Uint8Array> {
  const file = await handle.getFile()
  if (file.text) return file.text()
  if (file.arrayBuffer) return new Uint8Array(await file.arrayBuffer())
  throw new Error("File handle does not expose text or arrayBuffer")
}

async function writeProjectFile(directory: ProjectDirectoryHandle, path: string, value: string | Uint8Array): Promise<void> {
  const segments = path.split("/")
  const fileName = segments.pop()!
  let current = directory
  let writable: ProjectWritableFile | undefined
  try {
    for (const segment of segments) current = await current.getDirectoryHandle(segment, { create: true })
    const handle = await current.getFileHandle(fileName, { create: true })
    writable = await handle.createWritable()
    await writable.write(value)
    await writable.close()
  } catch (cause) {
    await writable?.abort?.().catch(() => undefined)
    throw new ProjectWriteError(path, cause)
  }
}

async function rollbackCreatedDirectory(parent: ProjectDirectoryHandle, projectId: string, directory: ProjectDirectoryHandle): Promise<void> {
  if (!parent.removeEntry) throw new Error("Parent handle cannot remove a created project")
  // `directory` is intentionally accepted to make the receipt explicit. It
  // is not re-resolved, so rollback cannot accidentally remove a replacement.
  void directory
  await parent.removeEntry(projectId, { recursive: true })
}

function validateProjectId(projectId: string): void {
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) throw new InvalidProjectPathError(projectId)
}

function isAbortError(cause: unknown): boolean {
  return !!cause && typeof cause === "object" && ((cause as { name?: string }).name === "AbortError" || (cause as { code?: string }).code === "cancelled")
}

function isNotFoundError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false
  const error = cause as { name?: string; code?: number | string; message?: string }
  return error.name === "NotFoundError" || error.code === 8 || error.code === "not-found" || /not found|missing/i.test(error.message ?? "")
}

export * from "./authoring"
export * from "./path"
