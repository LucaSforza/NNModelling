---
kind: knowledge
status: current
updated: 2026-09-10
---

# Electron desktop host

The Electron host packages the shared NNModelling frontend for Linux. It is a
platform boundary, not a second application core.

## Process ownership

- The renderer owns `DiagramCore`, the active package catalog, Lua inference,
  viewport state, training-controller state, and project save orchestration.
- The main process owns application lifecycle, the trusted `app://nnmodelling`
  protocol, native directory dialogs, and host filesystem calls.
- The preload process exposes only the typed project capability described
  below. It owns no persistent project or diagram state.
- MCP remains a thin optional proxy to the active renderer. Electron main and
  preload processes are never an alternate MCP graph authority.

## Security contract

Every application window uses:

- `contextIsolation: true`;
- `nodeIntegration: false`;
- renderer sandboxing enabled;
- a fixed preload script shipped with the application;
- the privileged application content loaded only from the registered
  `app://nnmodelling` scheme;
- denied unexpected navigation, popup, permission, and external-protocol
  requests.

The preload bridge must not expose `ipcRenderer`, Node.js modules, shell
execution, arbitrary IPC channels, or path-based general-purpose filesystem
methods. Main-process handlers validate channel arguments independently of
renderer validation.

## Project capability

Native directory selection returns an opaque, random, session-scoped
capability. Renderer calls combine that capability with a normalized relative
path and one explicit operation from the desktop project API:

- select a parent or existing project directory;
- list one directory;
- read one file;
- create one child directory or file;
- replace one file's bytes;
- remove a newly created entry during proven rollback.

The main process resolves every relative path beneath the capability root,
rejects absolute paths and traversal, and does not follow an operation outside
that root. Capabilities are invalid after application exit and are never
serialized into project, MCP, or backend data.

File replacement must not expose partially written `model.json` content.
Errors preserve cancellation, permission, collision, missing-entry, and write
failure as distinguishable renderer outcomes. The shared
`ProjectModelWriter` remains responsible for save ordering and visible state.

## Network boundary

The renderer origin is `app://nnmodelling`. A remote-training backend must
allow that exact origin in `NNM_ALLOWED_ORIGINS`; wildcard origin access is not
part of this contract. The Flatpak network permission permits configured HTTP
backend and optional localhost MCP connections, but grants no backend identity
or authorization by itself.

## Flatpak boundary

The Flatpak does not request blanket `home` or `host` filesystem access.
Native selection must yield a portal-visible path usable inside the sandbox.
The application does not spawn or bundle FastAPI, Valkey, container engines,
workers, or training jobs.

See the accepted
[shared web and desktop decision](../decisions/web-and-flatpak-desktop-distribution.md)
and [pairing contract](pairing.md).
