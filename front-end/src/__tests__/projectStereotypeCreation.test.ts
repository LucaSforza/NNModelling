import { afterEach, describe, expect, test } from "vitest"
import {
  ProjectStereotypeAuthoringCoordinator,
  createProjectWorkspace,
  openProjectWorkspace,
  readProjectWorkspace,
  writeProjectFiles,
  type ProjectDirectoryHandle,
  type ProjectFile,
  type ProjectFileHandle,
  type ProjectWritableFile,
} from "../project-workspace"
import type { DiagramCoreSnapshot, ModelManifest } from "../core/types"
import { generateStereotypePackage } from "../stereotype-authoring"
import { resolveModelPackageRecords } from "../type-system/editor-runtime"

class File implements ProjectFile {
  constructor(public value: string | Uint8Array) {}
  async text(): Promise<string> { return typeof this.value === "string" ? this.value : new TextDecoder().decode(this.value) }
}

class FileHandle implements ProjectFileHandle {
  readonly kind = "file" as const
  constructor(readonly name: string, private readonly file: File) {}
  async getFile(): Promise<ProjectFile> { return this.file }
  async createWritable(): Promise<ProjectWritableFile> {
    return { write: async (value) => { this.file.value = value }, close: async () => undefined }
  }
}

class Directory implements ProjectDirectoryHandle {
  readonly kind = "directory" as const
  readonly directories = new Map<string, Directory>()
  readonly files = new Map<string, FileHandle>()
  removalFailure: Error | undefined
  constructor(readonly name = "root") {}
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ProjectDirectoryHandle> {
    const current = this.directories.get(name)
    if (current) return current
    if (!options?.create) throw Object.assign(new Error("not found"), { name: "NotFoundError" })
    const created = new Directory(name)
    this.directories.set(name, created)
    return created
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<ProjectFileHandle> {
    const current = this.files.get(name)
    if (current) return current
    if (!options?.create) throw Object.assign(new Error("not found"), { name: "NotFoundError" })
    const created = new FileHandle(name, new File(""))
    this.files.set(name, created)
    return created
  }
  async *entries(): AsyncIterable<[string, ProjectDirectoryHandle | ProjectFileHandle]> {
    for (const [name, value] of this.directories) yield [name, value]
    for (const [name, value] of this.files) yield [name, value]
  }
  async removeEntry(name: string): Promise<void> {
    if (this.removalFailure) throw this.removalFailure
    this.directories.delete(name)
  }
}

const manifest: ModelManifest = { schemaVersion: 1, id: "demo", version: "1.0.0", name: "Demo", customPackages: [] }
const modelJson = JSON.stringify({ manifest, nodes: [], edges: [] })
const request = {
  id: "model.custom",
  version: "1.0.0",
  directory: "packages/custom",
  name: "Custom",
  kind: "layer" as const,
  view: { color: "#123456", width: 100, height: 60 },
  parameters: [],
}

let parent: Directory | undefined

afterEach(() => { parent = undefined })

describe("project stereotype authoring transaction", () => {
  test("writes four resources, one manifest entry and commits one prepared scope", async () => {
    parent = new Directory()
    const session = await createProjectWorkspace(parent, "demo", modelJson)
    const diagram = new FakeDiagram(manifest, modelJson)
    const coordinator = new ProjectStereotypeAuthoringCoordinator(session, diagram)

    const result = await coordinator.author(request)
    const loaded = await readProjectWorkspace(session.directory)
    expect(Object.keys(loaded.resources).sort()).toEqual([
      "model.json",
      "packages/custom/inference.lua",
      "packages/custom/manifest.json",
      "packages/custom/pytorch.py",
      "packages/custom/stereotype.json",
    ])
    expect(JSON.parse(loaded.modelJson).manifest.customPackages).toEqual([{
      id: "model.custom", version: "1.0.0", path: "packages/custom",
    }])
    expect(diagram.commits).toBe(1)
    expect(result.generated.files["pytorch.py"]).toContain("torch.nn.Identity()")
  })

  test("removes only the newly created package and restores the model after activation failure", async () => {
    parent = new Directory()
    const session = await createProjectWorkspace(parent, "demo", modelJson)
    const diagram = new FakeDiagram(manifest, modelJson, true)
    const coordinator = new ProjectStereotypeAuthoringCoordinator(session, diagram)

    await expect(coordinator.author(request)).rejects.toThrow("activation failed")
    const loaded = await readProjectWorkspace(session.directory)
    expect(loaded.modelJson).toBe(modelJson)
    expect(loaded.resources).not.toHaveProperty("packages/custom/manifest.json")
    expect(diagram.restores).toBe(1)
  })

  test("preserves graph edits made while the created package scope is preparing", async () => {
    parent = new Directory()
    const session = await createProjectWorkspace(parent, "demo", modelJson)
    const diagram = new FakeDiagram(manifest, modelJson)
    const coordinator = new ProjectStereotypeAuthoringCoordinator(session, diagram)
    diagram.beforePrepare = async () => {
      diagram.beforePrepare = undefined
      await Promise.resolve()
      diagram.addGraphNode("concurrent-create")
    }

    await coordinator.author(request)

    const persisted = JSON.parse((await readProjectWorkspace(session.directory)).modelJson)
    expect(persisted.nodes).toContainEqual(expect.objectContaining({ id: "concurrent-create" }))
    expect(JSON.parse(diagram.exportToJson()).nodes).toContainEqual(expect.objectContaining({ id: "concurrent-create" }))
  })

  test("deletes one exact project stereotype and commits the reduced live scope", async () => {
    parent = new Directory()
    const session = await createProjectWorkspace(parent, "demo", modelJson)
    const diagram = new FakeDiagram(manifest, modelJson)
    const coordinator = new ProjectStereotypeAuthoringCoordinator(session, diagram)
    const { generated } = await coordinator.author(request)

    await expect(coordinator.delete(generated.modelPackage)).resolves.toEqual(generated.modelPackage)

    const loaded = await readProjectWorkspace(session.directory)
    expect(JSON.parse(loaded.modelJson).manifest.customPackages).toEqual([])
    expect(Object.keys(loaded.resources)).toEqual(["model.json"])
    expect(diagram.modelManifest.customPackages).toEqual([])
    expect(diagram.commits).toBe(2)
  })

  test("preserves graph edits made while the reduced package scope is preparing", async () => {
    parent = new Directory()
    const session = await createProjectWorkspace(parent, "demo", modelJson)
    const diagram = new FakeDiagram(manifest, modelJson)
    const coordinator = new ProjectStereotypeAuthoringCoordinator(session, diagram)
    const { generated } = await coordinator.author(request)
    diagram.beforePrepare = async () => {
      diagram.beforePrepare = undefined
      await Promise.resolve()
      diagram.addGraphNode("concurrent-delete")
    }

    await coordinator.delete(generated.modelPackage)

    const persisted = JSON.parse((await readProjectWorkspace(session.directory)).modelJson)
    expect(persisted.nodes).toContainEqual(expect.objectContaining({ id: "concurrent-delete" }))
    expect(JSON.parse(diagram.exportToJson()).nodes).toContainEqual(expect.objectContaining({ id: "concurrent-delete" }))
  })

  test("does not add a deleted package while the asynchronous scope swap is committing", async () => {
    parent = new Directory()
    const session = await createProjectWorkspace(parent, "demo", modelJson)
    const diagram = new FakeDiagram(manifest, modelJson)
    const coordinator = new ProjectStereotypeAuthoringCoordinator(session, diagram)
    const { generated } = await coordinator.author(request)
    let rejectedDuringSwap = false
    diagram.beforeScopeSwap = async () => {
      await Promise.resolve()
      try {
        diagram.addPackageNode(generated.modelPackage.id, generated.modelPackage.version)
      } catch {
        rejectedDuringSwap = true
      }
    }

    await coordinator.delete(generated.modelPackage)

    const persisted = JSON.parse((await readProjectWorkspace(session.directory)).modelJson)
    expect(rejectedDuringSwap).toBe(true)
    expect(persisted.manifest.customPackages).toEqual([])
    expect(persisted.nodes.some((node: { data?: { package?: { id?: string; version?: string } } }) => (
      node.data?.package?.id === generated.modelPackage.id &&
      node.data.package.version === generated.modelPackage.version
    ))).toBe(false)
  })

  test("rejects core, graph-used, and dependency-required targets without mutation", async () => {
    parent = new Directory()
    const session = await createProjectWorkspace(parent, "demo", modelJson)
    const diagram = new FakeDiagram(manifest, modelJson)
    const coordinator = new ProjectStereotypeAuthoringCoordinator(session, diagram)
    const { generated } = await coordinator.author(request)
    const before = await readProjectWorkspace(session.directory)

    await expect(coordinator.delete({ id: "core.relu", version: "1.0.0", path: "packages/relu" })).rejects.toThrow(/not owned/)
    await expect(coordinator.delete({ ...generated.modelPackage, path: "packages/other" })).rejects.toThrow(/not owned/)
    diagram.addPackageNode(generated.modelPackage.id, generated.modelPackage.version)
    await expect(coordinator.delete(generated.modelPackage)).rejects.toThrow(/used by the project graph/)
    diagram.clearGraph()
    diagram.exports.set("model.dependent@1.0.0", {
      manifest: { schemaVersion: 1, id: "model.dependent", version: "1.0.0", dependencies: {}, entrypoints: { definition: "stereotype.json" } },
      definition: { name: "Dependent", kind: "layer", view: { color: "#000000", width: 1, height: 1 }, parameters: {} },
      resolvedDependencies: { "model.custom": "model.custom@1.0.0" },
      state: "failed",
    })
    await expect(coordinator.delete(generated.modelPackage)).rejects.toThrow(/required by another/)

    expect(await readProjectWorkspace(session.directory)).toEqual(before)
    expect(diagram.modelManifest.customPackages).toEqual([generated.modelPackage])
  })

  test("rejects deleting a dependency from package records loaded by the model runtime", async () => {
    parent = new Directory()
    const target = generateStereotypePackage({
      ...request,
      id: "qa.mcp-layer",
      directory: "packages/qa.mcp-layer",
    })
    const dependent = {
      id: "qa.dependent",
      version: "1.0.0",
      path: "packages/qa.dependent",
    }
    const dependentManifest = {
      schemaVersion: 1,
      id: dependent.id,
      version: dependent.version,
      dependencies: { "qa.mcp-layer": "^1.0.0" },
      entrypoints: { definition: "stereotype.json" },
    }
    const dependentDefinition = {
      name: "Dependent",
      kind: "layer",
      view: { color: "#123456", width: 100, height: 60 },
      parameters: {},
    }
    const projectManifest: ModelManifest = {
      ...manifest,
      customPackages: [target.modelPackage, dependent],
    }
    const projectJson = JSON.stringify({ manifest: projectManifest, nodes: [], edges: [] })
    const projectFiles = {
      "model.json": projectJson,
      ...Object.fromEntries(Object.entries(target.files).map(([path, value]) => [`${target.modelPackage.path}/${path}`, value])),
      [`${dependent.path}/manifest.json`]: JSON.stringify(dependentManifest),
      [`${dependent.path}/stereotype.json`]: JSON.stringify(dependentDefinition),
    }
    await writeProjectFiles(parent, projectFiles)
    const session = await openProjectWorkspace(parent)
    const runtimeRecords = await resolveModelPackageRecords(projectManifest, session.resources)
    const diagram = new FakeDiagram(projectManifest, projectJson)
    diagram.exports = new Map(runtimeRecords.map((record) => [record.key, {
      manifest: record.manifest,
      definition: record.definition,
      resources: record.resources,
      resolvedDependencies: record.resolvedDependencies,
    }]))
    const coordinator = new ProjectStereotypeAuthoringCoordinator(session, diagram)

    await expect(coordinator.delete(target.modelPackage)).rejects.toThrow(/required by another project stereotype/)

    expect(runtimeRecords.find((record) => record.manifest.id === dependent.id)?.resolvedDependencies)
      .toEqual({ "qa.mcp-layer": "qa.mcp-layer@1.0.0" })
    expect(await readProjectWorkspace(session.directory)).toEqual({
      modelJson: session.modelJson,
      resources: session.resources,
    })
  })

  test("restores the exact package and manifest when deletion cannot finish", async () => {
    parent = new Directory()
    const session = await createProjectWorkspace(parent, "demo", modelJson)
    const diagram = new FakeDiagram(manifest, modelJson)
    const coordinator = new ProjectStereotypeAuthoringCoordinator(session, diagram)
    const { generated } = await coordinator.author(request)
    const packages = await session.directory.getDirectoryHandle("packages") as Directory
    packages.removalFailure = new Error("directory is busy")

    await expect(coordinator.delete(generated.modelPackage)).rejects.toThrow(/directory is busy/)

    const restored = await readProjectWorkspace(session.directory)
    expect(JSON.parse(restored.modelJson).manifest.customPackages).toEqual([generated.modelPackage])
    expect(restored.resources).toHaveProperty("packages/custom/stereotype.json")
    expect(diagram.modelManifest.customPackages).toEqual([generated.modelPackage])
  })

  test("restores package files, manifest, and active scope after commit failure", async () => {
    parent = new Directory()
    const session = await createProjectWorkspace(parent, "demo", modelJson)
    const diagram = new FakeDiagram(manifest, modelJson)
    const coordinator = new ProjectStereotypeAuthoringCoordinator(session, diagram)
    const { generated } = await coordinator.author(request)
    diagram.failCommit = true

    await expect(coordinator.delete(generated.modelPackage)).rejects.toThrow(/activation failed/)

    const restored = await readProjectWorkspace(session.directory)
    expect(JSON.parse(restored.modelJson).manifest.customPackages).toEqual([generated.modelPackage])
    expect(restored.resources).toHaveProperty("packages/custom/stereotype.json")
    expect(diagram.modelManifest.customPackages).toEqual([generated.modelPackage])
    expect(diagram.restores).toBe(1)
  })
})

class FakeDiagram {
  commits = 0
  restores = 0
  failCommit: boolean
  exports = new Map<string, import("../type-system/packages/types").PackageExportInfo>()
  beforePrepare: (() => Promise<void> | void) | undefined
  beforeScopeSwap: (() => Promise<void> | void) | undefined
  private scopeTransition = false
  private visiblePackages = new Set<string>()
  private project: Record<string, unknown>
  constructor(
    public modelManifest: ModelManifest,
    json: string,
    failCommit = false,
  ) {
    this.project = JSON.parse(json) as Record<string, unknown>
    this.failCommit = failCommit
  }
  exportToJson(): string { return JSON.stringify({ ...this.project, manifest: this.modelManifest }) }
  packageExports() { return this.exports }
  addPackageNode(id: string, version: string): void {
    const key = `${id}@${version}`
    if (this.scopeTransition || !this.visiblePackages.has(key)) throw new Error(`package '${key}' is unavailable`)
    this.project.nodes = [{ id: "node", data: { package: { id, version } } }]
  }
  addGraphNode(id: string): void {
    const nodes = Array.isArray(this.project.nodes) ? this.project.nodes : []
    this.project.nodes = [...nodes, { id, position: { x: 350, y: 20 }, data: { concurrent: true } }]
  }
  clearGraph(): void { this.project.nodes = [] }
  async prepareProjectScope(modelJson: string, modelBundle: Record<string, string | Uint8Array>) {
    const project = JSON.parse(modelJson) as Record<string, unknown>
    const beforePrepare = this.beforePrepare
    this.beforePrepare = undefined
    await beforePrepare?.()
    return { snapshot: { manifest: project.manifest, nodes: project.nodes ?? [], edges: project.edges ?? [], layoutDirection: "vertical" }, scope: { modelBundle } } as never
  }
  async commitPreparedProjectScope(
    prepared: { readonly snapshot: DiagramCoreSnapshot },
    options: { readonly preserveLiveGraph?: boolean } = {},
  ): Promise<void> {
    this.commits += 1
    const current = JSON.parse(this.exportToJson()) as DiagramCoreSnapshot
    const snapshot = options.preserveLiveGraph
      ? { ...prepared.snapshot, ...current, manifest: prepared.snapshot.manifest }
      : prepared.snapshot
    this.modelManifest = snapshot.manifest
    this.project = { ...snapshot }
    this.scopeTransition = true
    this.visiblePackages.clear()
    const beforeScopeSwap = this.beforeScopeSwap
    this.beforeScopeSwap = undefined
    await beforeScopeSwap?.()
    if (this.failCommit) throw new Error("activation failed")
    this.visiblePackages = new Set(snapshot.manifest.customPackages.map((candidate) => `${candidate.id}@${candidate.version}`))
    this.scopeTransition = false
  }
  async restoreProjectScope(modelJson: string): Promise<void> {
    this.restores += 1
    this.project = JSON.parse(modelJson) as Record<string, unknown>
    this.modelManifest = this.project.manifest as ModelManifest
    this.visiblePackages = new Set(this.modelManifest.customPackages.map((candidate) => `${candidate.id}@${candidate.version}`))
    this.scopeTransition = false
  }
}
