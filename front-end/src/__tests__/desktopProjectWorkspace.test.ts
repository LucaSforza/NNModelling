import { describe, expect, test } from "vitest"
import {
  desktopProjectDirectoryPicker,
  type DesktopProjectEntry,
  type DesktopProjectFile,
  type DesktopProjectFilesystemBridge,
} from "../project-workspace/desktop"
import { ProjectSelectionCancelledError, ProjectWorkspaceAdapter } from "../project-workspace"

const MODEL = JSON.stringify({ manifest: { schemaVersion: 1, id: "demo", version: "1.0.0", name: "Demo", customPackages: [] }, nodes: [], edges: [] })

class FakeBridge implements DesktopProjectFilesystemBridge {
  readonly version = 1 as const
  readonly files = new Map<string, DesktopProjectFile>([["model.json", { encoding: "utf8", data: MODEL }]])
  readonly writes: Array<{ path: string; value: DesktopProjectFile }> = []

  async pickDirectory(): Promise<{ capability: string; name: string }> { return { capability: "opaque-capability", name: "demo" } }
  async ensureDirectory(): Promise<void> {}
  async stat(_capability: string, path: string): Promise<"file" | "directory" | null> {
    return this.files.has(path) ? "file" : path === "" ? "directory" : null
  }
  async listDirectory(_capability: string, path: string): Promise<readonly DesktopProjectEntry[]> {
    if (path !== "") return []
    return [...this.files.keys()].map((name) => ({ name, kind: "file" as const }))
  }
  async readFile(_capability: string, path: string): Promise<DesktopProjectFile> {
    const value = this.files.get(path)
    if (!value) throw new DOMException("missing", "NotFoundError")
    return value
  }
  async writeFile(_capability: string, path: string, value: DesktopProjectFile): Promise<void> {
    this.writes.push({ path, value })
    this.files.set(path, value)
  }
  async removeEntry(): Promise<void> {}
}

describe("desktop project workspace bridge", () => {
  test("preserves project loading and ordered model writes behind an opaque capability", async () => {
    const bridge = new FakeBridge()
    const adapter = new ProjectWorkspaceAdapter(desktopProjectDirectoryPicker(bridge))
    const session = await adapter.openProject()

    expect(session.modelJson).toBe(MODEL)
    expect(session.directory.name).toBe("demo")
    const changed = MODEL.replace('"Demo"', '"Changed"')
    await session.save(changed)

    expect(bridge.writes).toEqual([{ path: "model.json", value: { encoding: "utf8", data: changed } }])
  })

  test("maps a cancelled native picker to the existing workspace error", async () => {
    const bridge: DesktopProjectFilesystemBridge = {
      version: 1,
      pickDirectory: async () => null,
      ensureDirectory: async () => undefined,
      stat: async () => null,
      listDirectory: async () => [],
      readFile: async () => ({ encoding: "utf8", data: "" }),
      writeFile: async () => undefined,
      removeEntry: async () => undefined,
    }
    await expect(new ProjectWorkspaceAdapter(desktopProjectDirectoryPicker(bridge)).openProject())
      .rejects.toBeInstanceOf(ProjectSelectionCancelledError)
  })
})
