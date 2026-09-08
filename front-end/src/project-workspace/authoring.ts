import type { DiagramCoreSnapshot, ModelManifest } from "../core/types"
import { generateStereotypePackage, type GeneratedStereotypeResources, type StereotypeAuthoringRequest } from "../stereotype-authoring"
import type { ModelBundleResources, PreparedModelScope } from "../type-system/editor-runtime"
import {
  ensureProjectPermission,
  normalizeProjectPath,
  type ProjectDirectoryHandle,
  type ProjectWorkspaceSession,
  writeProjectFiles,
} from "./index"

export type PreparedProjectScope = {
  readonly snapshot: DiagramCoreSnapshot
  readonly scope: PreparedModelScope
}

/** The narrow Diagram seam needed by project-owned stereotype authoring. */
export interface ProjectAuthoringDiagram {
  readonly modelManifest: ModelManifest
  exportToJson(): string
  prepareProjectScope(modelJson: string, modelBundle: ModelBundleResources): Promise<PreparedProjectScope>
  commitPreparedProjectScope(prepared: PreparedProjectScope): Promise<void>
  restoreProjectScope(modelJson: string, modelBundle: ModelBundleResources): Promise<void>
}

export type ProjectAuthoringPhase = "validation" | "scope" | "package-write" | "model-write" | "activation" | "rollback"

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
  private modelJson: string
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly session: ProjectWorkspaceSession,
    private readonly diagram: ProjectAuthoringDiagram,
  ) {
    this.resources = { ...session.resources }
    this.modelJson = session.modelJson
  }

  author(request: StereotypeAuthoringRequest): Promise<ProjectStereotypeAuthoringResult> {
    const operation = this.tail.then(() => this.run(request))
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async run(request: StereotypeAuthoringRequest): Promise<ProjectStereotypeAuthoringResult> {
    // The session's initial modelJson is intentionally immutable. Graph
    // autosaves may have advanced since startup, so author against the live
    // DiagramCore snapshot and use that same snapshot for rollback.
    const previousModelJson = this.diagram.exportToJson()
    let generated: GeneratedStereotypeResources
    try {
      generated = generateStereotypePackage(request)
    } catch (cause) {
      throw new ProjectStereotypeAuthoringError(messageOf(cause), "validation", cause)
    }

    const packagePath = normalizeProjectPath(generated.modelPackage.path)
    const packagePrefix = `${packagePath}/`
    if (this.diagram.modelManifest.customPackages.some((candidate) => (
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
    try {
      await ensureProjectPermission(this.session.directory)
    } catch (cause) {
      throw new ProjectStereotypeAuthoringError(messageOf(cause), "package-write", cause)
    }

    const currentParsed = JSON.parse(previousModelJson) as Record<string, unknown>
    const currentManifest = this.diagram.modelManifest
    const nextManifest: ModelManifest = {
      ...currentManifest,
      customPackages: [...currentManifest.customPackages, generated.modelPackage],
    }
    const nextProject = { ...currentParsed, manifest: nextManifest }
    const nextModelJson = JSON.stringify(nextProject, null, 2)
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
    let commitAttempted = false
    try {
      try {
        await writeProjectFiles(created.directory, generated.files)
      } catch (cause) {
        throw new ProjectStereotypeAuthoringError(messageOf(cause), "package-write", cause)
      }
      try {
        modelWriteAttempted = true
        await this.session.save(nextModelJson)
      } catch (cause) {
        throw new ProjectStereotypeAuthoringError(messageOf(cause), "model-write", cause)
      }
      try {
        commitAttempted = true
        await this.diagram.commitPreparedProjectScope(prepared)
      } catch (cause) {
        throw new ProjectStereotypeAuthoringError(messageOf(cause), "activation", cause)
      }
    } catch (operationError) {
      const rollbackErrors: unknown[] = []
      if (modelWriteAttempted) {
        try { await this.session.save(previousModelJson) } catch (cause) { rollbackErrors.push(new Error(`model restore: ${messageOf(cause)}`)) }
      }
      try { await removeCreatedPackageDirectory(created) } catch (cause) { rollbackErrors.push(new Error(`package removal: ${messageOf(cause)}`)) }
      if (commitAttempted) {
        try { await this.diagram.restoreProjectScope(previousModelJson, this.resources) } catch (cause) { rollbackErrors.push(new Error(`runtime restore: ${messageOf(cause)}`)) }
      }
      if (rollbackErrors.length > 0) throw new ProjectAuthoringRollbackError(operationError, new Error(rollbackErrors.map(messageOf).join("; ")))
      throw operationError
    }

    this.resources = nextResources
    this.modelJson = nextModelJson
    return { generated, modelJson: nextModelJson }
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

function isNotFoundError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false
  const error = cause as { name?: string; code?: number | string; message?: string }
  return error.name === "NotFoundError" || error.code === 8 || error.code === "not-found" || /not found|missing/i.test(error.message ?? "")
}

function messageOf(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
