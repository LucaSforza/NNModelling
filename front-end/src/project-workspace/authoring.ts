import type { DiagramCoreSnapshot, ModelManifest, ModelPackageReference } from "../core/types"
import { generateStereotypePackage, type GeneratedStereotypeResources, type StereotypeAuthoringRequest } from "../stereotype-authoring"
import type { ModelBundleResources, PreparedModelScope } from "../type-system/editor-runtime"
import type { PackageExportInfo, PackageKey } from "../type-system/packages/types"
import {
  ensureProjectPermission,
  normalizeProjectPath,
  type ProjectDirectoryHandle,
  type ProjectFileHandle,
  type ProjectWorkspaceSession,
  writeProjectFiles,
} from "./index"

export type PreparedProjectScope = {
  readonly snapshot: DiagramCoreSnapshot
  readonly scope: PreparedModelScope
}

/** The narrow Diagram seam needed by project-owned stereotype authoring. */
export interface ProjectAuthoringDiagram {
  modelManifest: ModelManifest
  exportToJson(): string
  packageExports(): ReadonlyMap<string, PackageExportInfo>
  prepareProjectScope(modelJson: string, modelBundle: ModelBundleResources): Promise<PreparedProjectScope>
  commitPreparedProjectScope(prepared: PreparedProjectScope, options?: { readonly preserveLiveGraph?: boolean }): Promise<void>
  restoreProjectScope(modelJson: string, modelBundle: ModelBundleResources): Promise<void>
}

export type ProjectAuthoringPhase = "validation" | "scope" | "package-write" | "package-delete" | "model-write" | "activation" | "rollback"

export class ProjectStereotypeAuthoringError extends Error {
  constructor(
    message: string,
    readonly phase: ProjectAuthoringPhase,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = "ProjectStereotypeAuthoringError"
  }
}

export class ProjectAuthoringRollbackError extends ProjectStereotypeAuthoringError {
  constructor(
    readonly operationError: unknown,
    readonly rollbackError: unknown,
  ) {
    super(
      `Stereotype authoring failed and rollback also failed: ${messageOf(operationError)}; manual recovery required: ${messageOf(rollbackError)}`,
      "rollback",
      rollbackError,
    )
    this.name = "ProjectAuthoringRollbackError"
  }
}

export type ProjectStereotypeAuthoringResult = {
  readonly generated: GeneratedStereotypeResources
  readonly modelJson: string
}

/**
 * Owns the one authoring transaction for a project session. The coordinator
 * keeps a private resource snapshot because session handles are capabilities,
 * not mutable domain state; the filesystem remains the durable source.
 */
export class ProjectStereotypeAuthoringCoordinator {
  private resources: ModelBundleResources
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly session: ProjectWorkspaceSession,
    private readonly diagram: ProjectAuthoringDiagram,
  ) {
    this.resources = { ...session.resources }
  }

  author(request: StereotypeAuthoringRequest): Promise<ProjectStereotypeAuthoringResult> {
    const operation = this.tail.then(() => this.run(request))
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  delete(target: ModelPackageReference): Promise<ModelPackageReference> {
    const operation = this.tail.then(() => this.runDelete(target))
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async run(request: StereotypeAuthoringRequest): Promise<ProjectStereotypeAuthoringResult> {
    const previousModelJson = this.diagram.exportToJson()
    let generated: GeneratedStereotypeResources
    try {
      generated = generateStereotypePackage(request)
    } catch (cause) {
      throw new ProjectStereotypeAuthoringError(messageOf(cause), "validation", cause)
    }

    const packagePath = normalizeProjectPath(generated.modelPackage.path)
    const packagePrefix = `${packagePath}/`
    try {
      await ensureProjectPermission(this.session.directory)
    } catch (cause) {
      throw new ProjectStereotypeAuthoringError(messageOf(cause), "package-write", cause)
    }

    const currentManifest = this.diagram.modelManifest
    if (currentManifest.customPackages.some((candidate) => (
      candidate.id === generated.modelPackage.id || candidate.path === packagePath
    ))) {
      throw new ProjectStereotypeAuthoringError(
        `Model package '${generated.modelPackage.id}@${generated.modelPackage.version}' or path '${packagePath}' already exists`,
        "validation",
      )
    }
    if (Object.keys(this.resources).some((path) => path === packagePath || path.startsWith(packagePrefix))) {
      throw new ProjectStereotypeAuthoringError(`Project package directory '${packagePath}' already exists`, "validation")
    }
    const nextManifest: ModelManifest = {
      ...currentManifest,
      customPackages: [...currentManifest.customPackages, generated.modelPackage],
    }
    let nextModelJson = withModelManifest(this.diagram.exportToJson(), nextManifest)
    const nextResources: ModelBundleResources = {
      ...this.resources,
      ...Object.fromEntries(Object.entries(generated.files).map(([path, value]) => [`${packagePrefix}${path}`, value])),
    }

    let prepared: PreparedProjectScope
    try {
      prepared = await this.diagram.prepareProjectScope(nextModelJson, nextResources)
    } catch (cause) {
      throw new ProjectStereotypeAuthoringError(messageOf(cause), "scope", cause)
    }

    const created = await createPackageDirectory(this.session.directory, packagePath)
    let modelWriteAttempted = false
    let modelManifestInstalled = false
    let commitAttempted = false
    try {
      try {
        await writeProjectFiles(created.directory, generated.files)
      } catch (cause) {
        throw new ProjectStereotypeAuthoringError(messageOf(cause), "package-write", cause)
      }
      try {
        modelWriteAttempted = true
        this.diagram.modelManifest = nextManifest
        modelManifestInstalled = true
        // Include graph edits made while scope preparation and package I/O
        // were awaiting; the Diagram commit also rebases at its boundary.
        nextModelJson = withModelManifest(this.diagram.exportToJson(), nextManifest)
        await this.session.save(nextModelJson)
      } catch (cause) {
        throw new ProjectStereotypeAuthoringError(messageOf(cause), "model-write", cause)
      }
      try {
        commitAttempted = true
        await this.diagram.commitPreparedProjectScope(prepared, { preserveLiveGraph: true })
      } catch (cause) {
        throw new ProjectStereotypeAuthoringError(messageOf(cause), "activation", cause)
      }
      const committedModelJson = this.diagram.exportToJson()
      if (committedModelJson !== nextModelJson) {
        await this.session.save(committedModelJson)
        nextModelJson = committedModelJson
      }
    } catch (operationError) {
      const rollbackErrors: unknown[] = []
      if (modelManifestInstalled) this.diagram.modelManifest = currentManifest
      const rollbackModelJson = modelJsonForRollback(previousModelJson, this.diagram.exportToJson(), currentManifest)
      if (modelWriteAttempted) {
        try { await this.session.save(rollbackModelJson) } catch (cause) { rollbackErrors.push(new Error(`model restore: ${messageOf(cause)}`)) }
      }
      try { await removeCreatedPackageDirectory(created) } catch (cause) { rollbackErrors.push(new Error(`package removal: ${messageOf(cause)}`)) }
      if (commitAttempted) {
        try { await this.diagram.restoreProjectScope(rollbackModelJson, this.resources) } catch (cause) { rollbackErrors.push(new Error(`runtime restore: ${messageOf(cause)}`)) }
      }
      if (rollbackErrors.length > 0) throw new ProjectAuthoringRollbackError(operationError, new Error(rollbackErrors.map(messageOf).join("; ")))
      throw operationError
    }

    this.resources = nextResources
    return { generated, modelJson: nextModelJson }
  }

  private async runDelete(target: ModelPackageReference): Promise<ModelPackageReference> {
    const initialManifest = this.diagram.modelManifest
    const initialTarget = initialManifest.customPackages.find((candidate) => samePackageIdentity(candidate, target))
    if (!initialTarget) {
      throw new ProjectStereotypeAuthoringError(
        `Stereotype '${target.id}@${target.version}' at '${target.path}' is not owned by the active project`,
        "validation",
      )
    }
    if (graphUsesPackage(this.diagram.exportToJson(), initialTarget)) {
      throw new ProjectStereotypeAuthoringError(
        `Stereotype '${initialTarget.id}@${initialTarget.version}' is used by the project graph`,
        "validation",
      )
    }
    if (isRequiredByAnotherPackage(this.diagram.packageExports(), initialTarget)) {
      throw new ProjectStereotypeAuthoringError(
        `Stereotype '${initialTarget.id}@${initialTarget.version}' is required by another project stereotype`,
        "validation",
      )
    }
    if (!this.session.directory.removeEntry) {
      throw new ProjectStereotypeAuthoringError("The browser cannot remove project stereotype directories", "package-delete")
    }

    let directory: ProjectDirectoryHandle
    let previousPackageResources: Record<string, string | Uint8Array>
    let previousPackageDirectories: string[]
    try {
      await ensureProjectPermission(this.session.directory)
      directory = await openPackageDirectory(this.session.directory, initialTarget.path)
      const snapshot = await readPackageDirectory(directory, initialTarget.path)
      previousPackageResources = snapshot.resources
      previousPackageDirectories = snapshot.directories
    } catch (cause) {
      throw new ProjectStereotypeAuthoringError(messageOf(cause), "package-delete", cause)
    }

    const previousModelJson = this.diagram.exportToJson()
    const currentManifest = this.diagram.modelManifest
    const owned = currentManifest.customPackages.find((candidate) => samePackageIdentity(candidate, target))
    if (!owned) {
      throw new ProjectStereotypeAuthoringError(
        `Stereotype '${target.id}@${target.version}' is no longer owned by the active project`,
        "validation",
      )
    }
    if (graphUsesPackage(previousModelJson, owned)) {
      throw new ProjectStereotypeAuthoringError(
        `Stereotype '${owned.id}@${owned.version}' is used by the project graph`,
        "validation",
      )
    }
    if (isRequiredByAnotherPackage(this.diagram.packageExports(), owned)) {
      throw new ProjectStereotypeAuthoringError(
        `Stereotype '${owned.id}@${owned.version}' is required by another project stereotype`,
        "validation",
      )
    }

    const prefix = `${owned.path}/`
    const nextResources = Object.fromEntries(
      Object.entries(this.resources).filter(([path]) => !path.startsWith(prefix)),
    )
    const nextPackages = currentManifest.customPackages.filter((candidate) => !samePackageIdentity(candidate, owned))
    const nextManifest: ModelManifest = { ...currentManifest, customPackages: nextPackages }
    let nextModelJson = withModelManifest(previousModelJson, nextManifest)

    let prepared: PreparedProjectScope
    try {
      prepared = await this.diagram.prepareProjectScope(nextModelJson, nextResources)
    } catch (cause) {
      throw new ProjectStereotypeAuthoringError(messageOf(cause), "scope", cause)
    }

    const parentPath = owned.path.split("/").slice(0, -1).join("/")
    const directoryName = owned.path.split("/").pop()!
    let modelWriteAttempted = false
    let directoryRemovalAttempted = false
    let modelManifestInstalled = false
    let commitAttempted = false
    try {
      try {
        modelWriteAttempted = true
        this.diagram.modelManifest = nextManifest
        modelManifestInstalled = true
        nextModelJson = withModelManifest(this.diagram.exportToJson(), nextManifest)
        await this.session.save(nextModelJson)
      } catch (cause) {
        throw new ProjectStereotypeAuthoringError(messageOf(cause), "model-write", cause)
      }
      try {
        directoryRemovalAttempted = true
        const parent = parentPath ? await openPackageDirectory(this.session.directory, parentPath) : this.session.directory
        if (!parent.removeEntry) throw new Error("The browser cannot remove project stereotype directories")
        await parent.removeEntry(directoryName, { recursive: true })
      } catch (cause) {
        throw new ProjectStereotypeAuthoringError(messageOf(cause), "package-delete", cause)
      }
      try {
        commitAttempted = true
        await this.diagram.commitPreparedProjectScope(prepared, { preserveLiveGraph: true })
      } catch (cause) {
        throw new ProjectStereotypeAuthoringError(messageOf(cause), "activation", cause)
      }
      const committedModelJson = this.diagram.exportToJson()
      if (committedModelJson !== nextModelJson) {
        await this.session.save(committedModelJson)
        nextModelJson = committedModelJson
      }
    } catch (operationError) {
      const rollbackErrors: unknown[] = []
      if (modelManifestInstalled) this.diagram.modelManifest = currentManifest
      const rollbackModelJson = modelJsonForRollback(previousModelJson, this.diagram.exportToJson(), currentManifest)
      if (directoryRemovalAttempted) {
        try {
          await restorePackageDirectory(this.session.directory, owned.path, previousPackageDirectories, previousPackageResources)
        } catch (cause) {
          rollbackErrors.push(new Error(`package restore: ${messageOf(cause)}`))
        }
      }
      if (modelWriteAttempted) {
        try { await this.session.save(rollbackModelJson) } catch (cause) { rollbackErrors.push(new Error(`model restore: ${messageOf(cause)}`)) }
      }
      if (commitAttempted) {
        const previousResources = { ...this.resources, ...previousPackageResources }
        try { await this.diagram.restoreProjectScope(rollbackModelJson, previousResources) }
        catch (cause) { rollbackErrors.push(new Error(`runtime restore: ${messageOf(cause)}`)) }
      }
      if (rollbackErrors.length > 0) throw new ProjectAuthoringRollbackError(operationError, new Error(rollbackErrors.map(messageOf).join("; ")))
      throw operationError
    }

    this.resources = nextResources
    return owned
  }
}

type CreatedPackageDirectory = {
  readonly directory: ProjectDirectoryHandle
  readonly parent: ProjectDirectoryHandle
  readonly name: string
}

async function createPackageDirectory(root: ProjectDirectoryHandle, path: string): Promise<CreatedPackageDirectory> {
  const segments = path.split("/")
  const name = segments.pop()!
  let parent = root
  for (const segment of segments) {
    try {
      parent = await parent.getDirectoryHandle(segment)
    } catch (cause) {
      if (!isNotFoundError(cause)) throw new ProjectStereotypeAuthoringError(messageOf(cause), "package-write", cause)
      parent = await parent.getDirectoryHandle(segment, { create: true })
    }
  }
  try {
    await parent.getDirectoryHandle(name)
  } catch (cause) {
    if (!isNotFoundError(cause)) throw new ProjectStereotypeAuthoringError(messageOf(cause), "package-write", cause)
    return { directory: await parent.getDirectoryHandle(name, { create: true }), parent, name }
  }
  throw new ProjectStereotypeAuthoringError(`Project package directory '${path}' already exists`, "package-write")
}

async function removeCreatedPackageDirectory(created: CreatedPackageDirectory): Promise<void> {
  if (!created.parent.removeEntry) throw new Error(`Cannot remove newly created package directory '${created.name}'`)
  await created.parent.removeEntry(created.name, { recursive: true })
}

async function openPackageDirectory(root: ProjectDirectoryHandle, path: string): Promise<ProjectDirectoryHandle> {
  let directory = root
  for (const part of normalizeProjectPath(path).split("/")) directory = await directory.getDirectoryHandle(part)
  return directory
}

async function readPackageDirectory(
  directory: ProjectDirectoryHandle,
  projectPath: string,
): Promise<{ readonly resources: Record<string, string | Uint8Array>; readonly directories: string[] }> {
  const resources: Record<string, string | Uint8Array> = {}
  const directories: string[] = []
  await readPackageEntries(directory, projectPath, resources, directories)
  return { resources, directories }
}

async function readPackageEntries(
  directory: ProjectDirectoryHandle,
  prefix: string,
  resources: Record<string, string | Uint8Array>,
  directories: string[],
): Promise<void> {
  const entries = directory.entries ? directory.entries() : directory.values ? namedEntries(directory.values()) : undefined
  if (!entries) throw new Error("Directory handle does not support recursive enumeration")
  for await (const [name, handle] of entries) {
    const path = normalizeProjectPath(`${prefix}/${name}`)
    if (isProjectDirectory(handle)) {
      directories.push(path)
      await readPackageEntries(handle, path, resources, directories)
    } else {
      const file = await (handle as ProjectFileHandle).getFile()
      // Prefer bytes because File.text() would corrupt arbitrary binary assets
      // when a failed deletion needs to restore the exact package contents.
      if (file.arrayBuffer) resources[path] = new Uint8Array(await file.arrayBuffer())
      else if (file.text) resources[path] = await file.text()
      else throw new Error(`Project file '${path}' cannot be read`)
    }
  }
}

async function* namedEntries(
  values: AsyncIterable<ProjectDirectoryHandle | ProjectFileHandle>,
): AsyncIterable<[string, ProjectDirectoryHandle | ProjectFileHandle]> {
  for await (const handle of values) {
    if (!handle.name) throw new Error("File system entry has no name")
    yield [handle.name, handle]
  }
}

function isProjectDirectory(handle: ProjectDirectoryHandle | ProjectFileHandle): handle is ProjectDirectoryHandle {
  return handle.kind === "directory" || (handle.kind === undefined && ("entries" in handle || "values" in handle))
}

async function restorePackageDirectory(
  root: ProjectDirectoryHandle,
  path: string,
  directories: readonly string[],
  resources: Readonly<Record<string, string | Uint8Array>>,
): Promise<void> {
  const packageDirectory = await createPackageDirectoryForRestore(root, path)
  for (const directoryPath of directories) {
    await openOrCreatePackageDirectory(root, directoryPath)
  }
  const prefix = `${path}/`
  const files = Object.fromEntries(Object.entries(resources)
    .filter(([resourcePath]) => resourcePath.startsWith(prefix))
    .map(([resourcePath, value]) => [resourcePath.slice(prefix.length), value]))
  await writeProjectFiles(packageDirectory, files)
}

async function createPackageDirectoryForRestore(root: ProjectDirectoryHandle, path: string): Promise<ProjectDirectoryHandle> {
  const segments = normalizeProjectPath(path).split("/")
  const name = segments.pop()!
  let parent = root
  for (const segment of segments) parent = await openOrCreateChildDirectory(parent, segment)
  return openOrCreateChildDirectory(parent, name)
}

async function openOrCreatePackageDirectory(root: ProjectDirectoryHandle, path: string): Promise<ProjectDirectoryHandle> {
  let directory = root
  for (const part of normalizeProjectPath(path).split("/")) directory = await openOrCreateChildDirectory(directory, part)
  return directory
}

async function openOrCreateChildDirectory(parent: ProjectDirectoryHandle, name: string): Promise<ProjectDirectoryHandle> {
  try { return await parent.getDirectoryHandle(name) }
  catch (cause) {
    if (!isNotFoundError(cause)) throw cause
    return parent.getDirectoryHandle(name, { create: true })
  }
}

function graphUsesPackage(modelJson: string, target: ModelPackageReference): boolean {
  const project = JSON.parse(modelJson) as { readonly nodes?: unknown }
  if (!Array.isArray(project.nodes)) return false
  return project.nodes.some((value) => {
    if (!value || typeof value !== "object") return false
    const node = value as { readonly data?: { readonly package?: { readonly id?: unknown; readonly version?: unknown } } }
    return node.data?.package?.id === target.id && node.data.package.version === target.version
  })
}

function withModelManifest(modelJson: string, manifest: ModelManifest): string {
  const project = JSON.parse(modelJson) as Record<string, unknown>
  return JSON.stringify({ ...project, manifest }, null, 2)
}

function modelJsonForRollback(previousModelJson: string, liveModelJson: string, manifest: ModelManifest): string {
  const previous = JSON.parse(previousModelJson) as Record<string, unknown>
  const live = JSON.parse(liveModelJson) as Record<string, unknown>
  const graphUnchanged = JSON.stringify(previous.nodes ?? []) === JSON.stringify(live.nodes ?? []) &&
    JSON.stringify(previous.edges ?? []) === JSON.stringify(live.edges ?? [])
  if (graphUnchanged) return previousModelJson
  return JSON.stringify({ ...previous, nodes: live.nodes ?? [], edges: live.edges ?? [], manifest }, null, 2)
}

function isRequiredByAnotherPackage(
  packageExports: ReadonlyMap<string, PackageExportInfo>,
  target: ModelPackageReference,
): boolean {
  const targetKey: PackageKey = `${target.id}@${target.version}`
  for (const [candidateKey, candidate] of packageExports) {
    if (candidateKey === targetKey) continue
    if (Object.values(candidate.resolvedDependencies ?? {}).includes(targetKey)) return true
  }
  return false
}

function samePackageIdentity(left: ModelPackageReference, right: ModelPackageReference): boolean {
  return left.id === right.id && left.version === right.version && left.path === right.path
}

function isNotFoundError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false
  const error = cause as { name?: string; code?: number | string; message?: string }
  return error.name === "NotFoundError" || error.code === 8 || error.code === "not-found" || /not found|missing/i.test(error.message ?? "")
}

function messageOf(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
