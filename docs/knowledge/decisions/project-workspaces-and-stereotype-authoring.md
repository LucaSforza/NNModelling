---
kind: decision
status: accepted
updated: 2026-08-29
---

# Writable project workspaces and model-owned stereotype authoring

## Context

Package-native models now declare their complete custom stereotype scope in
`manifest.customPackages`, and those package directories live inside the model
bundle. The current frontend still opens an untitled diagram immediately,
downloads standalone JSON through **Save**, accepts standalone JSON through
**Load JSON**, and presents a global external-package installer backed by
IndexedDB. Those interactions no longer match project ownership.

Users also need to create a model-owned stereotype without assembling its four
required files by hand. The generated files must be ordinary project files so
the user can edit the Lua and PyTorch implementations outside NNModelling.

## Decision

- The user-facing unit is a **project**. A project is stored as one writable
  directory containing `model.json` and any model-owned resources. “Bundle” is
  transport and implementation terminology, not the primary UI label.
- Startup shows a project chooser before constructing or displaying the graph
  editor. It offers **New project** and **Open project**.
- New-project creation first asks for a parent directory. After the model form
  is accepted, NNModelling creates one child directory named by the validated
  model ID. An existing child is rejected; it is never merged or overwritten.
- Opening a project selects its directory through the same writable filesystem
  capability. NNModelling reads `model.json` and all declared model resources,
  then retains the directory handle only for the current browser session.
- Filesystem handles and absolute paths never enter `model.json`, package
  manifests, backend payloads, or browser RPC state.
- The model form owns `id`, `version`, `name`, and optional `description`.
  Phase one generates `schemaVersion: 1` and the initial empty
  `customPackages` list. Phase two upgrades successful writes to the dataset
  manifest v2 defined by the project-owned dataset decision.
- `model.json` is saved automatically after accepted graph or model metadata
  changes. Writes use one ordered writer and expose saving, saved, and failed
  states. A failed write remains visible and must never be reported as saved.
- The editor displays `manifest.name` as the active project name. Standalone
  **Save JSON**, **Load JSON**, and **Load bundle** controls are removed from
  the editor's normal workflow.
- The visible **Packages** installer is replaced by a **Stereotypes** manager.
  It shows immutable core stereotypes and the exact custom stereotypes owned
  by the active project; it does not install arbitrary directories globally.
- Creating a stereotype collects package identity, display metadata, kind,
  view metadata, dependencies, and parameter definitions. Each parameter has
  a unique name, one supported package-schema type, and an explicit `top` or
  `bottom` position; type-specific fields are requested only when required.
- A successful create operation makes
  `packages/<stereotype-directory>/manifest.json`, `stereotype.json`,
  `inference.lua`, and `pytorch.py`, adds the exact relative entry to the
  model's `manifest.customPackages`, stages the resulting package scope, and
  exposes the stereotype in the current palette.
- Generation is transactional from the application's perspective: validate
  all content and the staged package scope before committing it; on a later
  filesystem or activation failure, restore the previous model and remove only
  the newly created directory that this operation proved it created.
- The default `layer` Lua scaffold accepts one tensor and returns that tensor
  unchanged. Its PyTorch scaffold exports `build(...)` and returns a documented
  `torch.nn.Identity` module. Other kinds receive a kind-appropriate, explicit
  scaffold and must not silently claim mathematical semantics they do not
  implement.
- Generated source is intentionally readable and commented around the public
  Lua inference and PyTorch builder contracts. It contains no hidden generated
  runtime dependency.
- External-package IndexedDB installation is no longer a user-facing source of
  custom stereotypes. Implementation machinery that has no remaining caller
  after project-scoped authoring is removed rather than retained as a second
  ownership model.

## Consequences

- The browser File System Access API is a required capability for editable
  projects. Unsupported or denied access produces a clear startup error; a
  read-only file-input fallback would not satisfy stereotype creation or
  automatic saving.
- Project creation, opening, graph editing, package authoring, and backend
  export all operate on the same `core + current-model-custom` package scope.
- Direct edits made by another application are not watched automatically.
  Reloading a project or an explicit future refresh action is the boundary for
  rereading those files.
- The accepted model-scoped package decision remains the identity and runtime
  foundation. This decision supersedes only its preservation of the visible
  global installer and the older IndexedDB ownership path where that path
  becomes unused.
- Project-local datasets share this writable project boundary. Their manifest,
  batch, transport, execution and deliberately bounded upload contracts are
  defined by the accepted
  [project-owned dataset decision](project-owned-datasets.md) and implemented
  as phase two of the same initiative.

## Implementation

The executable work is defined in
[`../../plans/active/project-workspaces-and-stereotype-authoring/plan.md`](../../plans/active/project-workspaces-and-stereotype-authoring/plan.md).
