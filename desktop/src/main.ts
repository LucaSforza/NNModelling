import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, type IpcMainInvokeEvent } from "electron"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { IPC_CHANNELS, type DesktopProjectCapability, type DesktopProjectEntry, type DesktopProjectFile, type ProjectPathRequest, type ProjectRemoveRequest, type ProjectWriteRequest } from "./protocol"
import { isAllowedNavigation, MAIN_WINDOW_WEB_PREFERENCES } from "./security"

protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}])

type Capability = {
  readonly root: string
  readonly senderId: number
}

const capabilities = new Map<string, Capability>()
const MAX_PROJECT_FILE_BYTES = 256 * 1024 * 1024
let rendererRoot = resolve(process.env.NNM_RENDERER_DIST ?? join(__dirname, "../../front-end/dist"))
let mainWindow: BrowserWindow | undefined

function registerProjectHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.pickDirectory, async (event): Promise<DesktopProjectCapability | null> => {
    assertMainRenderer(event)
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory", "createDirectory"],
      title: "Choose an NNModelling project directory",
    })
    if (result.canceled || result.filePaths[0] === undefined) return null
    const root = await fs.realpath(result.filePaths[0])
    const capability = randomUUID()
    capabilities.set(capability, { root, senderId: event.sender.id })
    return { capability, name: root.split(sep).at(-1) || "project" }
  })

  ipcMain.handle(IPC_CHANNELS.ensureDirectory, async (event, request: ProjectPathRequest): Promise<void> => {
    const target = await capabilityPath(event, request)
    await fs.mkdir(target, { recursive: true })
  })

  ipcMain.handle(IPC_CHANNELS.stat, async (event, request: ProjectPathRequest): Promise<"file" | "directory" | null> => {
    const target = await capabilityPath(event, request)
    try {
      const stat = await fs.lstat(target)
      if (stat.isSymbolicLink()) throw new Error("symbolic links are not allowed in projects")
      if (stat.isDirectory()) return "directory"
      if (stat.isFile()) return "file"
      throw new Error("project entry is not a regular file or directory")
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.listDirectory, async (event, request: ProjectPathRequest): Promise<readonly DesktopProjectEntry[]> => {
    const target = await capabilityPath(event, request)
    const entries = await fs.readdir(target, { withFileTypes: true })
    return entries.map((entry) => {
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in projects: ${entry.name}`)
      if (!entry.isDirectory() && !entry.isFile()) throw new Error(`unsupported project entry: ${entry.name}`)
      return { name: entry.name, kind: entry.isDirectory() ? "directory" : "file" }
    })
  })

  ipcMain.handle(IPC_CHANNELS.readFile, async (event, request: ProjectPathRequest): Promise<DesktopProjectFile> => {
    const target = await capabilityPath(event, request)
    const stat = await fs.lstat(target)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("project entry is not a regular file")
    if (stat.size > MAX_PROJECT_FILE_BYTES) throw new Error("project file is too large")
    const data = await fs.readFile(target)
    return { encoding: "base64", data: data.toString("base64") }
  })

  ipcMain.handle(IPC_CHANNELS.writeFile, async (event, request: ProjectWriteRequest): Promise<void> => {
    const target = await capabilityPath(event, request)
    const bytes = decodeFile(request.value)
    if (bytes.byteLength > MAX_PROJECT_FILE_BYTES) throw new Error("project file is too large")
    await fs.mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.nnm-tmp-${randomUUID()}`
    try {
      await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
      await fs.rename(temporary, target)
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  })

  ipcMain.handle(IPC_CHANNELS.removeEntry, async (event, request: ProjectRemoveRequest): Promise<void> => {
    if (!request.path) throw new Error("cannot remove the project root")
    const target = await capabilityPath(event, request)
    const stat = await fs.lstat(target)
    if (stat.isSymbolicLink()) throw new Error("symbolic links are not allowed in projects")
    await fs.rm(target, { recursive: request.recursive, force: false })
  })
}

function assertMainRenderer(event: IpcMainInvokeEvent): void {
  if (mainWindow === undefined || event.sender.id !== mainWindow.webContents.id) throw new Error("unauthorized renderer")
}

async function capabilityPath(event: IpcMainInvokeEvent, request: ProjectPathRequest): Promise<string> {
  assertMainRenderer(event)
  if (typeof request?.capability !== "string") throw new Error("invalid project capability")
  const capability = capabilities.get(request.capability)
  if (!capability || capability.senderId !== event.sender.id) throw new Error("unknown project capability")
  const path = normalizeRelativePath(request.path)
  const target = path ? resolve(capability.root, ...path.split("/")) : capability.root
  if (!isWithin(capability.root, target)) throw new Error("project path escapes its capability")
  await assertNoSymlinkEscape(capability.root, target)
  return target
}

async function assertNoSymlinkEscape(root: string, target: string): Promise<void> {
  const existing = await fs.realpath(target).catch((error) => {
    if (isNotFound(error)) return undefined
    throw error
  })
  if (existing !== undefined) {
    if (!isWithin(root, existing)) throw new Error("project path escapes its capability")
    return
  }
  let parent = dirname(target)
  while (true) {
    const resolvedParent = await fs.realpath(parent).catch((error) => {
      if (isNotFound(error)) return undefined
      throw error
    })
    if (resolvedParent !== undefined) {
      if (!isWithin(root, resolvedParent)) throw new Error("project path escapes its capability")
      return
    }
    const next = dirname(parent)
    if (next === parent) throw new Error("project path does not have a valid parent")
    parent = next
  }
}

function normalizeRelativePath(path: string): string {
  if (typeof path !== "string" || isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
    throw new Error("project path must be relative")
  }
  if (!path) return ""
  const segments = path.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("project path contains an unsafe segment")
  }
  return path
}

function isWithin(root: string, target: string): boolean {
  const boundary = relative(root, target)
  return boundary === "" || (boundary !== ".." && !boundary.startsWith(`..${sep}`) && !isAbsolute(boundary))
}

function decodeFile(value: DesktopProjectFile): Buffer {
  if (value?.encoding === "utf8" && typeof value.data === "string") return Buffer.from(value.data, "utf8")
  if (value?.encoding === "base64" && typeof value.data === "string") return Buffer.from(value.data, "base64")
  throw new Error("invalid project file payload")
}

function isNotFound(error: unknown): boolean { return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT" }

function registerRendererProtocol(): void {
  protocol.handle("app", async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== "nnmodelling") return new Response("Not found", { status: 404 })
      const requested = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html"
      if (requested.includes("\0") || requested.includes("\\")) return new Response("Not found", { status: 404 })
      const file = resolve(rendererRoot, ...requested.split("/"))
      if (!isWithin(rendererRoot, file)) return new Response("Not found", { status: 404 })
      return await net.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response("Not found", { status: 404 })
    }
  })
}

async function createWindow(): Promise<void> {
  const developmentUrl = process.env.NNM_DEV_SERVER_URL
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      ...MAIN_WINDOW_WEB_PREFERENCES,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, developmentUrl)) event.preventDefault()
  })
  mainWindow.on("closed", () => {
    capabilities.clear()
    mainWindow = undefined
  })
  if (developmentUrl) await mainWindow.loadURL(developmentUrl)
  else await mainWindow.loadURL("app://nnmodelling/index.html")
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  rendererRoot = await findRendererRoot()
  registerRendererProtocol()
  registerProjectHandlers()
  await createWindow()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => capabilities.clear())

async function findRendererRoot(): Promise<string> {
  const candidates = process.env.NNM_RENDERER_DIST
    ? [process.env.NNM_RENDERER_DIST]
    : [join(__dirname, "../renderer"), join(__dirname, "../../front-end/dist")]
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isDirectory()) return resolve(candidate)
    } catch {
      // Try the next packaging layout.
    }
  }
  throw new Error("NNModelling renderer assets were not found")
}
