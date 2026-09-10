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

/** The only renderer-facing filesystem surface exposed by preload. */
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

export const IPC_CHANNELS = {
  pickDirectory: "nnmodelling:project:pick-directory",
  ensureDirectory: "nnmodelling:project:ensure-directory",
  stat: "nnmodelling:project:stat",
  listDirectory: "nnmodelling:project:list-directory",
  readFile: "nnmodelling:project:read-file",
  writeFile: "nnmodelling:project:write-file",
  removeEntry: "nnmodelling:project:remove-entry",
} as const

export type ProjectPathRequest = {
  readonly capability: string
  readonly path: string
}

export type ProjectWriteRequest = ProjectPathRequest & {
  readonly value: DesktopProjectFile
}

export type ProjectRemoveRequest = ProjectPathRequest & {
  readonly recursive: boolean
}
