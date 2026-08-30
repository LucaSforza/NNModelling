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

/** Browser-local session for an MCP-selected path; persistence is notified to the MCP owner. */
export function createPathProjectSession(
  payload: ProjectPathPayload,
  saveRemote: (modelJson: string) => Promise<void>,
): ProjectWorkspaceSession {
  const files = new Map<string, string | Uint8Array>()
  for (const [name, resource] of Object.entries(payload.resources)) files.set(name, decode(resource))
  const directory = new MemoryDirectory(pathName(payload.projectPath), files)
  const resources = Object.fromEntries(files) as ModelBundleResources
  const writer = new ProjectModelWriter(async (modelJson) => {
    files.set("model.json", modelJson)
    await saveRemote(modelJson)
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
  constructor(readonly name: string, private readonly files: Map<string, string | Uint8Array>) {}
  async getFile(): Promise<ProjectFile> { return new MemoryFile(this.files, this.name) }
  async createWritable(): Promise<ProjectWritableFile> {
    return {
      write: async (value) => { this.files.set(this.name, typeof value === "string" ? value : new Uint8Array(value)) },
      close: async () => undefined,
    }
  }
}

class MemoryDirectory implements ProjectDirectoryHandle {
  readonly kind = "directory" as const
  constructor(readonly name: string, private readonly files: Map<string, string | Uint8Array>, private readonly prefix = "") {}
  async getDirectoryHandle(name: string): Promise<ProjectDirectoryHandle> { return new MemoryDirectory(name, this.files, this.key(name)) }
  async getFileHandle(name: string): Promise<ProjectFileHandle> { return new MemoryFileHandle(this.key(name), this.files) }
  async *entries(): AsyncIterable<[string, ProjectDirectoryHandle | ProjectFileHandle]> {
    const seen = new Set<string>()
    const start = this.prefix ? `${this.prefix}/` : ""
    for (const key of this.files.keys()) {
      if (!key.startsWith(start)) continue
      const rest = key.slice(start.length)
      const [head, ...tail] = rest.split("/")
      if (tail.length) { if (!seen.has(head)) { seen.add(head); yield [head, new MemoryDirectory(head, this.files, start + head)] } }
      else yield [head, new MemoryFileHandle(key, this.files)]
    }
  }
  private key(name: string): string { return this.prefix ? `${this.prefix}/${name}` : name }
}
