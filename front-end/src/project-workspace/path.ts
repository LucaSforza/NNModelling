import type { ModelBundleResources } from "../type-system/editor-runtime"
import {
  ProjectModelWriter,
  type ProjectDirectoryHandle,
  type ProjectFile,
  type ProjectFileHandle,
  type ProjectResourceSet,
  type ProjectWorkspaceSession,
  type ProjectWritableFile,
} from "./index"

export type ProjectPathPayload = {
  readonly projectPath: string
  readonly modelJson: string
  readonly resources: Record<string, { readonly encoding: "utf8" | "base64"; readonly data: string }>
}
type RemoteResource = ProjectPathPayload["resources"][string]

export type ProjectPathOperation =
  | { readonly kind: "write"; readonly path: string; readonly encoding: "utf8" | "base64"; readonly data: string }
  | { readonly kind: "remove"; readonly path: string; readonly recursive?: boolean }

type PersistProjectPathOperation = (operation: ProjectPathOperation) => Promise<void>

/** Browser-local session for an MCP-selected path; persistence is notified to the MCP owner. */
export function createPathProjectSession(
  payload: ProjectPathPayload,
  persistRemote: PersistProjectPathOperation,
): ProjectWorkspaceSession {
  const files = new Map<string, string | Uint8Array>()
  for (const [name, resource] of Object.entries(payload.resources)) files.set(name, decode(resource))
  const directories = new Set<string>([""])
  for (const name of files.keys()) {
    const parts = name.split("/")
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"))
  }
  const directory = new MemoryDirectory(pathName(payload.projectPath), files, directories, "", persistRemote)
  const resources = Object.fromEntries(files) as ModelBundleResources
  const writer = new ProjectModelWriter(async (modelJson) => {
    await persistRemote({ kind: "write", path: "model.json", encoding: "utf8", data: modelJson })
    files.set("model.json", modelJson)
  })
  const set: ProjectResourceSet = { modelJson: payload.modelJson, resources }
  return {
    ...set,
    directory,
    writer,
    save: (modelJson) => writer.save(modelJson),
    rollback: async () => { throw new Error("MCP-selected projects cannot be rolled back from the browser") },
  }
}

function decode(resource: RemoteResource): string | Uint8Array {
  if (resource.encoding === "utf8") return resource.data
  const bytes = Uint8Array.from(atob(resource.data), (value) => value.charCodeAt(0))
  return bytes
}

function pathName(projectPath: string): string { return projectPath.split(/[\\/]/).pop() || "project" }

class MemoryFile implements ProjectFile {
  constructor(private readonly files: Map<string, string | Uint8Array>, private readonly name: string) {}
  async text(): Promise<string> {
    const value = this.files.get(this.name) ?? ""
    return typeof value === "string" ? value : new TextDecoder().decode(value)
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    const value = this.files.get(this.name) ?? ""
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value
    return bytes.slice().buffer
  }
}

class MemoryFileHandle implements ProjectFileHandle {
  readonly kind = "file" as const
  constructor(
    readonly name: string,
    private readonly files: Map<string, string | Uint8Array>,
    private readonly persist: PersistProjectPathOperation,
  ) {}
  async getFile(): Promise<ProjectFile> { return new MemoryFile(this.files, this.name) }
  async createWritable(): Promise<ProjectWritableFile> {
    let pending: string | Uint8Array | undefined
    return {
      write: async (value) => {
        const normalized = typeof value === "string" ? value : new Uint8Array(value)
        await this.persist({
          kind: "write",
          path: this.name,
          encoding: typeof normalized === "string" ? "utf8" : "base64",
          data: typeof normalized === "string" ? normalized : encode(normalized),
        })
        pending = normalized
      },
      close: async () => {
        if (pending !== undefined) this.files.set(this.name, pending)
      },
    }
  }
}

class MemoryDirectory implements ProjectDirectoryHandle {
  readonly kind = "directory" as const
  constructor(
    readonly name: string,
    private readonly files: Map<string, string | Uint8Array>,
    private readonly directories: Set<string>,
    private readonly prefix = "",
    private readonly persist: PersistProjectPathOperation,
  ) {}
  async getDirectoryHandle(name: string, options?: { readonly create?: boolean }): Promise<ProjectDirectoryHandle> {
    const next = this.key(name)
    if (!this.directories.has(next)) {
      if (options?.create !== true) throw new DOMException(`Directory '${name}' was not found`, "NotFoundError")
      this.directories.add(next)
    }
    return new MemoryDirectory(name, this.files, this.directories, next, this.persist)
  }
  async getFileHandle(name: string): Promise<ProjectFileHandle> { return new MemoryFileHandle(this.key(name), this.files, this.persist) }
  async removeEntry(name: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const key = this.key(name)
    const isDirectory = this.directories.has(key)
    const isFile = this.files.has(key)
    if (!isDirectory && !isFile) throw new DOMException(`Entry '${name}' was not found`, "NotFoundError")
    const descendantPrefix = `${key}/`
    const hasChildren = isDirectory && ([...this.files.keys()].some((file) => file.startsWith(descendantPrefix)) || [...this.directories].some((directory) => directory.startsWith(descendantPrefix)))
    if (hasChildren && options?.recursive !== true) throw new DOMException(`Directory '${name}' is not empty`, "InvalidModificationError")
    await this.persist({ kind: "remove", path: key, recursive: isDirectory })
    this.files.delete(key)
    this.directories.delete(key)
    for (const file of [...this.files.keys()]) if (file.startsWith(descendantPrefix)) this.files.delete(file)
    for (const directory of [...this.directories]) if (directory.startsWith(descendantPrefix)) this.directories.delete(directory)
  }
  async *entries(): AsyncIterable<[string, ProjectDirectoryHandle | ProjectFileHandle]> {
    const seen = new Set<string>()
    const start = this.prefix ? `${this.prefix}/` : ""
    for (const directory of this.directories) {
      if (directory === this.prefix || !directory.startsWith(start)) continue
      const rest = directory.slice(start.length)
      if (rest.includes("/")) continue
      seen.add(rest)
      yield [rest, new MemoryDirectory(rest, this.files, this.directories, directory, this.persist)]
    }
    for (const key of this.files.keys()) {
      if (!key.startsWith(start)) continue
      const rest = key.slice(start.length)
      const [head, ...tail] = rest.split("/")
      if (tail.length) { if (!seen.has(head)) { seen.add(head); yield [head, new MemoryDirectory(head, this.files, this.directories, start + head, this.persist)] } }
      else yield [head, new MemoryFileHandle(key, this.files, this.persist)]
    }
  }
  private key(name: string): string { return this.prefix ? `${this.prefix}/${name}` : name }
}

function encode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
