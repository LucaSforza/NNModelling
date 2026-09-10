import {
  normalizeProjectPath,
  ProjectSelectionCancelledError,
  ProjectWorkspaceAdapter,
  type ProjectDirectoryHandle,
  type ProjectDirectoryPicker,
  type ProjectFile,
  type ProjectFileHandle,
  type ProjectWritableFile,
} from "./index"

export type DesktopProjectCapability = {
  readonly capability: string
  readonly name: string
}

export type DesktopProjectEntry = {
  readonly name: string
  readonly kind: "file" | "directory"
}

export type DesktopProjectFile = {
  readonly encoding: "utf8" | "base64"
  readonly data: string
}

/** Narrow renderer-side surface exposed by the Electron preload script. */
export interface DesktopProjectFilesystemBridge {
  readonly version: 1
  pickDirectory(options: { readonly mode: "readwrite" }): Promise<DesktopProjectCapability | null>
  ensureDirectory(capability: string, path: string): Promise<void>
  stat(capability: string, path: string): Promise<"file" | "directory" | null>
  listDirectory(capability: string, path: string): Promise<readonly DesktopProjectEntry[]>
  readFile(capability: string, path: string): Promise<DesktopProjectFile>
  writeFile(capability: string, path: string, value: DesktopProjectFile): Promise<void>
  removeEntry(capability: string, path: string, recursive: boolean): Promise<void>
}

declare global {
  interface Window {
    readonly nnmodellingDesktop?: DesktopProjectFilesystemBridge
  }
}

export type HostProjectWorkspace = {
  readonly adapter?: ProjectWorkspaceAdapter
  readonly desktop: boolean
}

/** Selects the native capability when Electron preload is present, web otherwise. */
export function projectWorkspaceForHost(): HostProjectWorkspace {
  const bridge = desktopProjectFilesystemBridge()
  return bridge
    ? { adapter: new ProjectWorkspaceAdapter(desktopProjectDirectoryPicker(bridge)), desktop: true }
    : { desktop: false }
}

export function desktopProjectFilesystemBridge(): DesktopProjectFilesystemBridge | undefined {
  if (typeof window === "undefined") return undefined
  const bridge = window.nnmodellingDesktop
  return bridge?.version === 1 ? bridge : undefined
}

export function desktopProjectDirectoryPicker(
  bridge: DesktopProjectFilesystemBridge,
): ProjectDirectoryPicker {
  return async (options) => {
    const selected = await bridge.pickDirectory(options)
    if (!selected) throw new ProjectSelectionCancelledError()
    return new DesktopDirectoryHandle(bridge, selected.capability, "", selected.name)
  }
}

class DesktopDirectoryHandle implements ProjectDirectoryHandle {
  readonly kind = "directory" as const

  constructor(
    private readonly bridge: DesktopProjectFilesystemBridge,
    private readonly capability: string,
    private readonly prefix: string,
    readonly name: string,
  ) {}

  async getDirectoryHandle(name: string, options?: { readonly create?: boolean }): Promise<ProjectDirectoryHandle> {
    const path = childPath(this.prefix, name)
    if (options?.create === true) {
      await this.bridge.ensureDirectory(this.capability, path)
    } else if (await this.bridge.stat(this.capability, path) !== "directory") {
      throw notFound(name)
    }
    return new DesktopDirectoryHandle(this.bridge, this.capability, path, leafName(path))
  }

  async getFileHandle(name: string, options?: { readonly create?: boolean }): Promise<ProjectFileHandle> {
    const path = childPath(this.prefix, name)
    if (options?.create !== true && await this.bridge.stat(this.capability, path) !== "file") {
      throw notFound(name)
    }
    return new DesktopFileHandle(this.bridge, this.capability, path, leafName(path))
  }

  async *entries(): AsyncIterable<[string, ProjectDirectoryHandle | ProjectFileHandle]> {
    for (const entry of await this.bridge.listDirectory(this.capability, this.prefix)) {
      const path = childPath(this.prefix, entry.name)
      yield [
        entry.name,
        entry.kind === "directory"
          ? new DesktopDirectoryHandle(this.bridge, this.capability, path, entry.name)
          : new DesktopFileHandle(this.bridge, this.capability, path, entry.name),
      ]
    }
  }

  async queryPermission(): Promise<PermissionState> { return "granted" }
  async requestPermission(): Promise<PermissionState> { return "granted" }

  async removeEntry(name: string, options?: { readonly recursive?: boolean }): Promise<void> {
    await this.bridge.removeEntry(this.capability, childPath(this.prefix, name), options?.recursive === true)
  }
}

class DesktopFileHandle implements ProjectFileHandle {
  readonly kind = "file" as const

  constructor(
    private readonly bridge: DesktopProjectFilesystemBridge,
    private readonly capability: string,
    private readonly path: string,
    readonly name: string,
  ) {}

  async getFile(): Promise<ProjectFile> {
    const value = await this.bridge.readFile(this.capability, this.path)
    return new DesktopFile(value)
  }

  async createWritable(): Promise<ProjectWritableFile> {
    let pending: DesktopProjectFile | undefined
    return {
      write: async (value) => {
        pending = typeof value === "string"
          ? { encoding: "utf8", data: value }
          : { encoding: "base64", data: encode(value) }
      },
      close: async () => {
        if (pending !== undefined) await this.bridge.writeFile(this.capability, this.path, pending)
      },
      abort: async () => { pending = undefined },
    }
  }
}

class DesktopFile implements ProjectFile {
  constructor(private readonly value: DesktopProjectFile) {}

  async text(): Promise<string> {
    return this.value.encoding === "utf8" ? this.value.data : new TextDecoder().decode(decode(this.value.data))
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = this.value.encoding === "utf8" ? new TextEncoder().encode(this.value.data) : decode(this.value.data)
    return bytes.slice().buffer
  }
}

function childPath(prefix: string, name: string): string {
  return normalizeProjectPath(prefix ? `${prefix}/${name}` : name)
}

function leafName(path: string): string { return path.split("/").at(-1)! }

function notFound(name: string): DOMException {
  return new DOMException(`Entry '${name}' was not found`, "NotFoundError")
}

function encode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0))
}
