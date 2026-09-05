import { describe, expect, test } from "vitest"
import {
  createProjectWorkspace,
  openProjectWorkspace,
  readProjectWorkspace,
  type ProjectDirectoryHandle,
  type ProjectFile,
  type ProjectFileHandle,
  type ProjectWritableFile,
} from "../project-workspace"
import {
  ProjectDatasetAuthoringCoordinator,
  generateDatasetResources,
  readDatasetDataFile,
} from "../project-workspace/dataset-authoring"
import type { ModelManifestV2 } from "../project-workspace/dataset-contract"

class MemoryFile implements ProjectFile {
  constructor(public value: string | Uint8Array) {}
  async text(): Promise<string> { return typeof this.value === "string" ? this.value : new TextDecoder().decode(this.value) }
}

class MemoryFileHandle implements ProjectFileHandle {
  readonly kind = "file" as const
  constructor(readonly name: string, private readonly file: MemoryFile) {}
  async getFile(): Promise<ProjectFile> { return this.file }
  async createWritable(): Promise<ProjectWritableFile> {
    return { write: async (value) => { this.file.value = value }, close: async () => undefined }
  }
}

class MemoryDirectory implements ProjectDirectoryHandle {
  readonly kind = "directory" as const
  readonly directories = new Map<string, MemoryDirectory>()
  readonly files = new Map<string, MemoryFileHandle>()
  removalFailure: Error | undefined
  constructor(readonly name = "root") {}
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ProjectDirectoryHandle> {
    const found = this.directories.get(name)
    if (found) return found
    if (!options?.create) throw Object.assign(new Error("not found"), { name: "NotFoundError" })
    const created = new MemoryDirectory(name)
    this.directories.set(name, created)
    return created
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<ProjectFileHandle> {
    const found = this.files.get(name)
    if (found) return found
    if (!options?.create) throw Object.assign(new Error("not found"), { name: "NotFoundError" })
    const created = new MemoryFileHandle(name, new MemoryFile(""))
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
    this.files.delete(name)
  }
}

const MODEL = JSON.stringify({
  manifest: { schemaVersion: 2, id: "demo", version: "1.0.0", name: "Demo", customPackages: [], customDatasets: [] },
  nodes: [],
  edges: [],
})

const REQUEST = {
  id: "demo.tokens",
  version: "1.0.0",
  directory: "datasets/tokens",
  name: "Tokens",
  description: "Named token batches",
  parameters: [{ name: "batch_size", type: "integer" as const, required: false, default: 32 }],
  inputs: [{ name: "tokens", shape: ["B", "T"], dtype: "int64" as const }],
  targets: [{ name: "next_tokens", shape: ["B", "T"], dtype: "int64" as const }],
  classes: { count: 2, names: ["no", "yes"] },
  dataFiles: [{ path: "train.pt", bytes: new Uint8Array([1, 2, 3]) }],
}

describe("project dataset authoring", () => {
  test("renders the manifest, definition, readable loader and data receipt", async () => {
    const generated = generateDatasetResources(REQUEST)
    expect(Object.keys(generated.files)).toEqual(["manifest.json", "dataset.json", "dataset.py"])
    expect(generated.modelDataset).toEqual({ id: "demo.tokens", version: "1.0.0", path: "datasets/tokens" })
    expect(JSON.parse(generated.files["dataset.json"]).batch).toEqual({
      inputs: { tokens: { shape: ["B", "T"], dtype: "int64" } },
      targets: { next_tokens: { shape: ["B", "T"], dtype: "int64" } },
    })
    expect(generated.files["dataset.py"]).toContain("def build(parameters")
    expect(generated.files["dataset.py"]).toContain("TrainingBatch")
    expect(generated.files["dataset.py"]).toContain("validation.pt")
    expect((await readDatasetDataFile({ name: "labels.csv", text: async () => "a,b" })).bytes).toEqual(new Uint8Array([97, 44, 98]))
  })

  test("generates the worker-compatible DatasetContext without backend imports", () => {
    const source = generateDatasetResources(REQUEST).files["dataset.py"]
    expect(source).toContain("resource_root: Path")
    expect(source).toContain("reference: Any | None = None")
    expect(source).toContain("context.resource_root / \"data\"")
    expect(source).not.toContain("context.root")
    expect(source).not.toContain("from dataset.contracts import")
  })

  test("creates and reopens an identical project dataset", async () => {
    const parent = new MemoryDirectory()
    const session = await createProjectWorkspace(parent, "demo", MODEL)
    const coordinator = new ProjectDatasetAuthoringCoordinator(session)
    await coordinator.author(REQUEST)

    const loaded = await readProjectWorkspace(session.directory)
    expect(JSON.parse(loaded.modelJson).manifest).toMatchObject({
      schemaVersion: 2,
      customDatasets: [{ id: "demo.tokens", version: "1.0.0", path: "datasets/tokens" }],
    })
    expect(Object.keys(loaded.resources).sort()).toEqual([
      "datasets/tokens/data/train.pt",
      "datasets/tokens/dataset.json",
      "datasets/tokens/dataset.py",
      "datasets/tokens/manifest.json",
      "model.json",
    ])
    const reopened = await openProjectWorkspace(session.directory)
    expect(new ProjectDatasetAuthoringCoordinator(reopened).listProjectDatasets()).toEqual([{ id: "demo.tokens", version: "1.0.0", path: "datasets/tokens" }])
  })

  test("authors against the current diagram snapshot without dropping graph or prior datasets", async () => {
    const parent = new MemoryDirectory()
    const session = await createProjectWorkspace(parent, "demo", MODEL)
    let graph = JSON.parse(MODEL) as Record<string, unknown>
    const model = {
      modelManifest: graph.manifest as ModelManifestV2,
      exportToJson() {
        return JSON.stringify({ ...graph, manifest: this.modelManifest })
      },
    }
    const coordinator = new ProjectDatasetAuthoringCoordinator(session, model)
    await coordinator.author(REQUEST)
    graph = { ...graph, nodes: [{ id: "input", position: { x: 350, y: 20 } }] }

    await coordinator.author({
      ...REQUEST,
      id: "demo.labels",
      directory: "datasets/labels",
      name: "Labels",
      dataFiles: [],
    })

    const saved = JSON.parse((await readProjectWorkspace(session.directory)).modelJson)
    expect(saved.nodes).toEqual([{ id: "input", position: { x: 350, y: 20 } }])
    expect(saved.manifest.customDatasets.map((dataset: { id: string }) => dataset.id)).toEqual(["demo.tokens", "demo.labels"])
    expect(model.modelManifest.customDatasets).toHaveLength(2)
  })

  test("rejects malformed requests and collisions before mutation", async () => {
    expect(() => generateDatasetResources({ ...REQUEST, directory: "../outside" })).toThrow()
    expect(() => generateDatasetResources({ ...REQUEST, inputs: [...REQUEST.inputs, { name: "next_tokens", shape: ["B"], dtype: "int64" }] })).toThrow(/slot/)
    const parent = new MemoryDirectory()
    const session = await createProjectWorkspace(parent, "demo", MODEL)
    const coordinator = new ProjectDatasetAuthoringCoordinator(session)
    await coordinator.author(REQUEST)
    const before = await readProjectWorkspace(session.directory)
    await expect(coordinator.author(REQUEST)).rejects.toThrow(/already exists/)
    expect((await readProjectWorkspace(session.directory)).modelJson).toBe(before.modelJson)
  })

  test("updates a dataset contract while preserving its source and existing data", async () => {
    const parent = new MemoryDirectory()
    const session = await createProjectWorkspace(parent, "demo", MODEL)
    const coordinator = new ProjectDatasetAuthoringCoordinator(session)
    await coordinator.author(REQUEST)
    const before = await readProjectWorkspace(session.directory)
    const target = { id: "demo.tokens", version: "1.0.0", path: "datasets/tokens" }

    const result = await coordinator.update(target, {
      ...REQUEST,
      name: "Updated tokens",
      dataFiles: [{ path: "validation.pt", bytes: new Uint8Array([4, 5, 6]) }],
    })

    expect(result.generated.definition.name).toBe("Updated tokens")
    expect(result.generated.files["dataset.py"]).toBe(before.resources["datasets/tokens/dataset.py"])
    const updated = await readProjectWorkspace(session.directory)
    expect(JSON.parse(updated.resources["datasets/tokens/dataset.json"] as string).name).toBe("Updated tokens")
    expect(updated.resources["datasets/tokens/dataset.py"]).toBe(before.resources["datasets/tokens/dataset.py"])
    expect(datasetBytes(updated.resources["datasets/tokens/data/train.pt"]!)).toEqual(new Uint8Array([1, 2, 3]))
    expect(datasetBytes(updated.resources["datasets/tokens/data/validation.pt"]!)).toEqual(new Uint8Array([4, 5, 6]))
  })

  test("rejects identity changes before mutating an existing dataset", async () => {
    const parent = new MemoryDirectory()
    const session = await createProjectWorkspace(parent, "demo", MODEL)
    const coordinator = new ProjectDatasetAuthoringCoordinator(session)
    await coordinator.author(REQUEST)
    const before = await readProjectWorkspace(session.directory)

    await expect(coordinator.update(
      { id: "demo.tokens", version: "1.0.0", path: "datasets/tokens" },
      { ...REQUEST, version: "1.1.0" },
    )).rejects.toThrow(/cannot be changed/)

    expect(await readProjectWorkspace(session.directory)).toEqual(before)
  })

  test("deletes the dataset directory and removes its model manifest entry", async () => {
    const parent = new MemoryDirectory()
    const session = await createProjectWorkspace(parent, "demo", MODEL)
    const coordinator = new ProjectDatasetAuthoringCoordinator(session)
    await coordinator.author(REQUEST)

    await coordinator.delete({ id: "demo.tokens", version: "1.0.0", path: "datasets/tokens" })

    const project = await readProjectWorkspace(session.directory)
    expect(JSON.parse(project.modelJson).manifest.customDatasets).toEqual([])
    const datasets = await session.directory.getDirectoryHandle("datasets")
    await expect(datasets.getDirectoryHandle("tokens")).rejects.toThrow(/not found/)
    expect(coordinator.listProjectDatasets()).toEqual([])
  })

  test("restores the dataset manifest when its directory cannot be removed", async () => {
    const parent = new MemoryDirectory()
    const session = await createProjectWorkspace(parent, "demo", MODEL)
    const coordinator = new ProjectDatasetAuthoringCoordinator(session)
    await coordinator.author(REQUEST)
    const datasets = await session.directory.getDirectoryHandle("datasets") as MemoryDirectory
    datasets.removalFailure = new Error("directory is busy")

    await expect(coordinator.delete({ id: "demo.tokens", version: "1.0.0", path: "datasets/tokens" })).rejects.toThrow(/directory is busy/)

    const restored = await readProjectWorkspace(session.directory)
    expect(JSON.parse(restored.modelJson).manifest.customDatasets).toEqual([{ id: "demo.tokens", version: "1.0.0", path: "datasets/tokens" }])
    await expect(datasets.getDirectoryHandle("tokens")).resolves.toBeDefined()
  })

  test("removes only the new directory when model persistence fails", async () => {
    const parent = new MemoryDirectory()
    const session = await createProjectWorkspace(parent, "demo", MODEL)
    const originalSave = session.save
    let first = true
    session.save = async (value) => {
      if (first) { first = false; throw new Error("disk full") }
      return originalSave(value)
    }
    await expect(new ProjectDatasetAuthoringCoordinator(session).author(REQUEST)).rejects.toThrow(/disk full/)
    const project = await session.directory.getDirectoryHandle("datasets")
    await expect(project.getDirectoryHandle("tokens")).rejects.toThrow()
    expect((await readProjectWorkspace(session.directory)).modelJson).toBe(MODEL)
  })

  test("does not roll back a newer graph save after a dataset write failure", async () => {
    const parent = new MemoryDirectory()
    const session = await createProjectWorkspace(parent, "demo", MODEL)
    let graph = JSON.parse(MODEL) as Record<string, unknown>
    const model = {
      modelManifest: graph.manifest as ModelManifestV2,
      exportToJson() {
        return JSON.stringify({ ...graph, manifest: this.modelManifest })
      },
    }
    const originalSave = session.save
    let first = true
    session.save = async (value) => {
      if (first) {
        first = false
        graph = { ...graph, nodes: [{ id: "latest", position: { x: 350, y: 20 } }] }
        // Simulate a newer graph save accepted while dataset authoring waits.
        void originalSave(model.exportToJson())
        throw new Error("disk full")
      }
      return originalSave(value)
    }

    const coordinator = new ProjectDatasetAuthoringCoordinator(session, model)
    await expect(coordinator.author(REQUEST)).rejects.toThrow(/disk full/)

    const restored = JSON.parse((await readProjectWorkspace(session.directory)).modelJson)
    expect(restored.nodes).toEqual([{ id: "latest", position: { x: 350, y: 20 } }])
    expect(restored.manifest.customDatasets).toEqual([])
  })
})

function datasetBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value
}
