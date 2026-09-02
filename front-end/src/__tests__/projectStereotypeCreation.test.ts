import { afterEach, describe, expect, test } from "vitest"
import {
  ProjectStereotypeAuthoringCoordinator,
  createProjectWorkspace,
  readProjectWorkspace,
  type ProjectDirectoryHandle,
  type ProjectFile,
  type ProjectFileHandle,
  type ProjectWritableFile,
} from "../project-workspace"
import type { ModelManifest } from "../core/types"

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
  async removeEntry(name: string): Promise<void> { this.directories.delete(name) }
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
})

class FakeDiagram {
  commits = 0
  restores = 0
  constructor(
    public modelManifest: ModelManifest,
    private readonly json: string,
    private readonly failCommit = false,
  ) {}
  exportToJson(): string { return this.json }
  async prepareProjectScope(modelJson: string, modelBundle: Record<string, string | Uint8Array>) {
    return { snapshot: { manifest: JSON.parse(modelJson).manifest, nodes: [], edges: [], layoutDirection: "vertical" }, scope: { modelBundle } } as never
  }
  async commitPreparedProjectScope(): Promise<void> {
    this.commits += 1
    if (this.failCommit) throw new Error("activation failed")
  }
  async restoreProjectScope(): Promise<void> { this.restores += 1 }
}

