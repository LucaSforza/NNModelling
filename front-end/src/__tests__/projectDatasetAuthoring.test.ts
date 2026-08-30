import { describe, expect, test } from "vitest"
import {
  ProjectDatasetAuthoringCoordinator,
  createProjectWorkspace,
  generateDatasetResources,
  openProjectWorkspace,
  readDatasetDataFile,
  readProjectWorkspace,
  type ProjectDirectoryHandle,
  type ProjectFile,
  type ProjectFileHandle,
  type ProjectWritableFile,
} from "../project-workspace"

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
  async removeEntry(name: string): Promise<void> { this.directories.delete(name) }
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
})
