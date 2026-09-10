import { contextBridge, ipcRenderer } from "electron"
import { IPC_CHANNELS, type DesktopProjectFilesystemBridge, type ProjectRemoveRequest, type ProjectWriteRequest } from "./protocol"

const bridge: DesktopProjectFilesystemBridge = {
  version: 1,
  pickDirectory: (options) => ipcRenderer.invoke(IPC_CHANNELS.pickDirectory, options),
  ensureDirectory: (capability, path) => ipcRenderer.invoke(IPC_CHANNELS.ensureDirectory, { capability, path }),
  stat: (capability, path) => ipcRenderer.invoke(IPC_CHANNELS.stat, { capability, path }),
  listDirectory: (capability, path) => ipcRenderer.invoke(IPC_CHANNELS.listDirectory, { capability, path }),
  readFile: (capability, path) => ipcRenderer.invoke(IPC_CHANNELS.readFile, { capability, path }),
  writeFile: (capability, path, value) => {
    const request: ProjectWriteRequest = { capability, path, value }
    return ipcRenderer.invoke(IPC_CHANNELS.writeFile, request)
  },
  removeEntry: (capability, path, recursive) => {
    const request: ProjectRemoveRequest = { capability, path, recursive }
    return ipcRenderer.invoke(IPC_CHANNELS.removeEntry, request)
  },
}

// Expose only typed project operations. The renderer never receives ipcRenderer,
// an absolute path, or a Node.js capability outside the opaque token.
contextBridge.exposeInMainWorld("nnmodellingDesktop", bridge)
