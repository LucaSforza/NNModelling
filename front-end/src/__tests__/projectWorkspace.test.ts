import { describe, expect, test, vi } from "vitest"

import {
  InvalidProjectPathError,
  ProjectCollisionError,
  ProjectModelWriter,
  ProjectPermissionDeniedError,
  ProjectSelectionCancelledError,
  ProjectWriteError,
  UnsupportedProjectFilesystemError,
  createProjectWorkspace,
  openProjectWorkspace,
  readProjectWorkspace,
  writeProjectFiles,
} from "../project-workspace"
import type {
  ProjectDirectoryHandle,
  ProjectFile,
  ProjectFileHandle,
  ProjectWritableFile,
} from "../project-workspace"

class MemoryFile implements ProjectFile {
  constructor(public value: string | Uint8Array) {}
  async text(): Promise<string> {
    return typeof this.value === "string" ? this.value : new TextDecoder().decode(this.value)
  }
}

class MemoryFileHandle implements ProjectFileHandle {
  readonly kind = "file" as const
  constructor(readonly name: string, private readonly file: MemoryFile, private readonly failWrite = false) {}
  async getFile(): Promise<ProjectFile> { return this.file }
  async createWritable(): Promise<ProjectWritableFile> {
    return {
      write: async (value) => {
        if (this.failWrite) throw new Error("disk full")
        this.file.value = value
      },
      close: async () => undefined,
    }
  }
}

class MemoryDirectory implements ProjectDirectoryHandle {
  readonly kind = "directory" as const
  readonly directories = new Map<string, MemoryDirectory>()
  readonly files = new Map<string, MemoryFileHandle>()
  permission: PermissionState = "granted"
  failWrites = false
  removed: string[] = []

  constructor(readonly name = "root", private readonly parent?: MemoryDirectory) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ProjectDirectoryHandle> {
    const existing = this.directories.get(name)
    if (existing) return existing
    if (!options?.create) throw Object.assign(new Error("not found"), { name: "NotFoundError" })
    const created = new MemoryDirectory(name, this)
    this.directories.set(name, created)
    return created
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<ProjectFileHandle> {
    const existing = this.files.get(name)
    if (existing) return existing
    if (!options?.create) throw Object.assign(new Error("not found"), { name: "NotFoundError" })
    const file = new MemoryFile("")
    const created = new MemoryFileHandle(name, file, this.failWrites)
    this.files.set(name, created)
    return created
  }

  async *entries(): AsyncIterable<[string, ProjectDirectoryHandle | ProjectFileHandle]> {
    for (const [name, directory] of this.directories) yield [name, directory]
    for (const [name, file] of this.files) yield [name, file]
  }

  async queryPermission(): Promise<PermissionState> { return this.permission }
  async requestPermission(): Promise<PermissionState> { return this.permission }
  async removeEntry(name: string): Promise<void> {
    this.removed.push(name)
    this.directories.delete(name)
  }
}

const MODEL = JSON.stringify({ manifest: { schemaVersion: 1, id: "demo", version: "1.0.0", name: "Demo", customPackages: [] }, nodes: [], edges: [] })

describe("project workspace filesystem boundary", () => {
  test("creates a child exactly once and returns the same resource shape as open", async () => {
    const parent = new MemoryDirectory()
    const created = await createProjectWorkspace(parent, "demo", MODEL)
    const opened = await openProjectWorkspace(created.directory)

    expect(created.modelJson).toBe(MODEL)
    expect(opened.modelJson).toBe(MODEL)
    expect(opened.resources["model.json"]).toBe(MODEL)
    expect(parent.directories.has("demo")).toBe(true)
  })

  test("rejects collisions before touching an existing child", async () => {
    const parent = new MemoryDirectory()
    await parent.getDirectoryHandle("demo", { create: true })
    await expect(createProjectWorkspace(parent, "demo", MODEL)).rejects.toBeInstanceOf(ProjectCollisionError)
    expect(parent.removed).toEqual([])
  })

  test("confines writes and validates every path before the first write", async () => {
    const project = new MemoryDirectory("demo")
    await expect(writeProjectFiles(project, { "packages/ok.txt": "ok", "../escape.txt": "no" }))
      .rejects.toBeInstanceOf(InvalidProjectPathError)
    expect(project.directories.size).toBe(0)
    await expect(writeProjectFiles(project, { "/absolute.txt": "no" })).rejects.toBeInstanceOf(InvalidProjectPathError)
    await expect(writeProjectFiles(project, { "C:\\absolute.txt": "no" })).rejects.toBeInstanceOf(InvalidProjectPathError)
  })

  test("reads nested resources and rejects malformed entry paths", async () => {
    const project = new MemoryDirectory("demo")
    await writeProjectFiles(project, { "model.json": MODEL, "packages/demo/inference.lua": "return {}" })
    const loaded = await readProjectWorkspace(project)
    expect(loaded.resources["packages/demo/inference.lua"]).toBe("return {}")

    const unsafe = new MemoryDirectory("unsafe")
    unsafe.directories.set("..", new MemoryDirectory("..", unsafe))
    await expect(readProjectWorkspace(unsafe)).rejects.toBeInstanceOf(InvalidProjectPathError)
  })

  test("removes only a child created by the current operation", async () => {
    const parent = new MemoryDirectory()
    const created = await createProjectWorkspace(parent, "demo", MODEL)
    await created.rollback()
    expect(parent.removed).toEqual(["demo"])
    await expect(created.rollback()).rejects.toThrow()

    const existing = new MemoryDirectory("existing")
    await writeProjectFiles(existing, { "model.json": MODEL })
    const opened = await openProjectWorkspace(existing)
    await expect(opened.rollback()).rejects.toThrow()
  })

  test("reports permission denial, unsupported browsers and cancellation distinctly", async () => {
    const denied = new MemoryDirectory()
    denied.permission = "denied"
    await expect(openProjectWorkspace(denied)).rejects.toBeInstanceOf(ProjectPermissionDeniedError)

    const previous = (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker
    delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker
    const { browserProjectDirectoryPicker } = await import("../project-workspace")
    expect(() => browserProjectDirectoryPicker()).toThrow(UnsupportedProjectFilesystemError)
    ;(globalThis as { showDirectoryPicker?: () => Promise<never> }).showDirectoryPicker = async () => {
      throw Object.assign(new Error("cancel"), { name: "AbortError" })
    }
    await expect(browserProjectDirectoryPicker()({ mode: "readwrite" })).rejects.toBeInstanceOf(ProjectSelectionCancelledError)
    ;(globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = previous
  })

  test("serializes delayed saves and exposes pending, saved and failed states", async () => {
    const gates: (() => void)[] = []
    const writes: string[] = []
    const writer = new ProjectModelWriter(async (value) => {
      await new Promise<void>((resolve) => gates.push(resolve))
      writes.push(value)
    })
    const states: string[] = []
    writer.subscribe((status) => states.push(status.state))
    const first = writer.save("v1")
    const second = writer.save("v2")
    expect(writer.status).toMatchObject({ state: "pending", pending: 2, latestAcceptedVersion: 2 })
    await Promise.resolve()
    gates.shift()!()
    await first
    expect(writes).toEqual(["v1"])
    expect(writer.status.state).toBe("pending")
    await Promise.resolve()
    gates.shift()!()
    await second
    expect(writes).toEqual(["v1", "v2"])
    expect(writer.status).toMatchObject({ state: "saved", pending: 0, latestSavedVersion: 2 })
    expect(states).toContain("pending")
    expect(states.at(-1)).toBe("saved")

    const failing = new ProjectModelWriter(async () => { throw new Error("disk full") })
    await expect(failing.save("bad")).rejects.toThrow("disk full")
    expect(failing.status.state).toBe("failed")
  })

  test("turns file failures into scoped write errors and preserves the failure", async () => {
    const project = new MemoryDirectory("demo")
    project.failWrites = true
    const session = await createProjectWorkspace(new MemoryDirectory(), "ok", MODEL)
    // The in-memory handle captures the failure behavior independently from
    // session construction, which proves callers observe a rejected save.
    vi.spyOn(session.directory, "getFileHandle").mockRejectedValue(new Error("disk full"))
    await expect(session.save(MODEL)).rejects.toBeInstanceOf(ProjectWriteError)
    expect(session.writer.status.state).toBe("failed")
    void project
  })
})
