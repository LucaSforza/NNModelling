---
kind: decision
status: accepted
updated: 2026-09-10
---

# Shared web and Flatpak desktop distribution

## Context

NNModelling is currently delivered as a Vite web application. Linux users also
need an installable desktop application, while the web application must remain
a first-class distribution with the same model and type semantics.

The frontend already keeps graph behavior in `DiagramCore` and places project
filesystem access behind `ProjectWorkspaceAdapter`. A desktop distribution can
therefore reuse the renderer instead of creating a second editor.

## Decision

- NNModelling has one Svelte renderer and two supported hosts: a web browser
  and an Electron desktop shell. The hosts may provide different platform
  adapters but must not fork graph, package, type-inference, persistence, or
  training semantics.
- `DiagramCore` in the active renderer remains the only authority for the live
  graph. Electron main and preload processes do not mirror diagram or package
  state.
- The Linux desktop application is distributed as Flatpak with the stable
  application ID `io.github.LucaSforza.NNModelling`.
- The Electron renderer loads the normal production frontend build with a
  relative Vite base. The independently deployed web build retains its
  configured web base path.
- Browser projects use the File System Access API. Electron projects use a
  narrow, typed preload bridge backed by native directory selection and
  main-process filesystem operations. Both satisfy the same
  `ProjectWorkspaceAdapter` behavior: explicit selection, ordered automatic
  saves, collision rejection, recursive resources, cancellation, and visible
  failures.
- The preload bridge exposes task-specific project operations only. It never
  exposes Node.js, `ipcRenderer`, arbitrary shell execution, or an unrestricted
  filesystem API to the renderer. Electron uses context isolation, sandboxing,
  and disabled renderer Node integration.
- Absolute paths and desktop capability identifiers are session-only. They
  never enter `model.json`, package manifests, MCP messages, backend payloads,
  or exported bundles.
- The Flatpak uses the Freedesktop runtime and Electron BaseApp, launches
  through Zypak, and requests only display, GPU, IPC, and network permissions.
  It does not receive blanket home-directory or host-filesystem access.
- The desktop application connects to the existing remote training backend.
  Python, Valkey, Podman/Docker, worker images, and training jobs are not
  embedded in the Flatpak.
- Browser-backed MCP remains an optional integration. When present, browser
  and Electron renderer connections route to their own live `DiagramCore`
  through the same thin proxy contract.

## Consequences

- Web and desktop releases exercise one frontend test suite; host-adapter tests
  cover only platform-specific selection, file I/O, and security boundaries.
- A production Flatpak build must be network-independent after its declared
  sources are fetched. Node and Electron sources are pinned from the workspace
  lock and generated Flatpak source manifest.
- Flatpak exports an application-ID-named desktop file, icon, and AppStream
  metadata. Before public release, manual QA builds, installs, launches, opens
  or creates a project through the portal-visible filesystem, saves it, closes
  the app, and reopens the project.
- Adding a bundled local backend would be a separate architectural decision
  because it changes sandbox permissions, lifecycle, resource ownership, and
  the least-privilege worker boundary.

## Implementation

The executable work is defined in
[`../../archive/completed-plans/linux-flatpak/plan.md`](../../archive/completed-plans/linux-flatpak/plan.md).
