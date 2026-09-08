---
id: project-workspaces-and-stereotype-authoring
kind: plan
status: ready
updated: 2026-08-29
areas: [architecture, frontend, backend, packages, datasets, testing]
---

# Writable projects, stereotypes and datasets

## Goal

Replace the diagram-first, standalone-JSON frontend with a project-first flow.
A user creates or opens a writable project, sees its model name, receives
ordered automatic persistence, and can author model-owned stereotypes. After
that slice passes a mandatory QA gate, extend the same ownership model to
project datasets and migrate built-in datasets to the same logical contract.

The accepted product contracts are recorded in:

- [`project-workspaces-and-stereotype-authoring.md`](../../../knowledge/decisions/project-workspaces-and-stereotype-authoring.md);
- [`project-owned-datasets.md`](../../../knowledge/decisions/project-owned-datasets.md).

This initiative builds on
[`model-scoped-stereotype-packages`](../model-scoped-stereotype-packages/plan.md)
and must consume its transactional model-switch seam rather than introduce a
second package lifecycle.

## Delivery phases and hard gate

### Phase 1: project workspace and stereotypes

- Choose a parent directory and create a child named by the validated model ID,
  or open an existing project directory with read/write permission.
- Show New/Open before mounting the editor; display the active model name.
- Replace Save JSON, Load JSON and Load bundle with ordered automatic save.
- Replace the global Packages installer with a project Stereotypes manager.
- Generate validated `manifest.json`, `stereotype.json`, `inference.lua` and
  `pytorch.py`, including parameter mini-forms with name, type and position.

### Gate: phase-one QA

T06 exercises phase 1 through the real browser-owned interface. Phase 2 must
not begin until T06 passes. T06 records defects and evidence but does not close
or archive the initiative.

### Phase 2: project-owned datasets

- Add a project Datasets manager and a generator for manifest, definition,
  Python entrypoint and project-local data directory.
- Introduce flat named input/target tensor maps and explicit graph/objective
  bindings, including ordinary paired and autoregressive datasets.
- Migrate built-in datasets to the same declarative parameter, batch and
  builder contract.
- Upload project dataset resources as a bounded, immutable archive; execute
  their Python only inside the isolated training worker.
- Select either a built-in or project dataset for each training job and record
  the exact dataset identity, version and digest.

## Current behavior

- `App.svelte` mounts `FlowCanvas` and constructs a diagram immediately. Core
  bootstrap creates an Input before a project has been selected.
- Save downloads `model.json`; standalone JSON cannot carry model-owned
  resources. Bundle loading reads a directory but retains no writable handle.
- `PackageManager.svelte` exposes a global IndexedDB-backed external-package
  installer, which conflicts with model-owned package scope.
- Backend dataset discovery imports trusted Python and introspects constructor
  signatures. Training requests expose a Python target, and the worker assumes
  each batch is exactly `(inputs, targets)`.
- Built-in dataset data is operator-owned; there is no project dataset catalog,
  resource transport or worker-only loader for browser-supplied dataset code.

## Non-goals

- Watching external file changes, persisting filesystem handles across reloads,
  recent-project lists, cloud storage, ZIP/Git/collaborative workflows or
  legacy standalone-JSON import.
- A package marketplace, global custom-package library, dependency solver,
  browser source editor, or editing/deleting existing authored resources in
  the first slice. Generated files remain editable on disk.
- Large-dataset transport: no multipart, resumable, delta or object-storage
  upload, background sync, quota/GC design or promise beyond the configured
  small/medium archive limit.
- External dataset paths, symlinks, network downloads, credentials, arbitrary
  nested batch objects or non-tensor model/objective bindings.
- Executing project package or dataset Python in FastAPI or on the host.
- Dataset-specific graph generation or automatic architecture changes.

## Shared decisions and invariants

- The project directory is the editable persistence boundary. New-project
  creation never overwrites or merges an existing model-ID child.
- `showDirectoryPicker({ mode: "readwrite" })` is the browser seam. Unsupported
  capability, cancellation and permission denial remain distinct outcomes.
- The directory handle is session state above `DiagramCore`; it is neither
  persisted nor exposed through MCP or backend contracts.
- `DiagramCore` remains the sole live graph authority. One ordered writer owns
  every `model.json` change, including resource-manifest updates.
- Authoring validates a complete in-memory resource set before mutation. A
  failed operation restores the previous manifest/runtime and removes only the
  exact directory proven to have been created by that operation.
- Core resources are immutable. Active custom stereotypes and datasets come
  only from exhaustive entries in the current project manifest.
- IDs, versions, relative paths, manifests and content digests must match.
  Paths are confined to the project root and implicit discovery is forbidden.
- Browser UI, `DiagramCore`, package export, training and MCP observe one
  committed model scope; no package-ID or dataset-ID semantic switches exist.

## Phase-one contracts

### Project lifecycle

```text
startup
  ├─ New ─> choose parent ─> validate model form ─> create <parent>/<id>/
  └─ Open ─> choose project directory
                         │
                         v
                ProjectWorkspaceSession
                         │ read model/resources
                         v
                staged model-scope activation
                         │
                         v
                  DiagramCore commit
                         │ graph notifications
                         v
             ordered automatic model.json writer
```

The editor mounts only after the workspace and model scope are ready. A failed
open leaves startup visible; a failed switch leaves the prior session intact.
Phase 1 writes manifest schema v1 with no custom packages initially.

### Stereotype authoring

```text
structured form
  ├─ manifest.json
  ├─ stereotype.json
  ├─ inference.lua
  └─ pytorch.py
          │ validate definition, entrypoints, dependencies and manifest
          v
stage proposed model scope
          │
          v
write package directory + model.json through the ordered writer
          │
          v
commit scope and refresh palette
```

Parameter names are unique; `position` is `top` or `bottom`; conditional fields
serialize the existing `ParameterDefinition` schema directly. A default layer
is transparent: Lua returns `context.inputs[1]`, while Python `build` returns
`torch.nn.Identity()`. Non-layer kinds receive explicit kind-safe scaffolds.

## Phase-two contracts

### Project manifest and layout

Phase 2 upgrades successful writes to manifest schema v2. Schema v1 remains
readable during migration and means `customDatasets: []`; it is not a permanent
semantic variant.

```text
<project>/
├── model.json
├── packages/<package-directory>/...
└── datasets/<dataset-directory>/
    ├── manifest.json
    ├── dataset.json
    ├── dataset.py
    └── data/
```

`manifest.customDatasets` is exhaustive. Dataset source and every project-owned
data byte live under its declared directory. `dataset.json` declares display
metadata, form parameters, named batch slots, class metadata and optional
declarative inference-adapter metadata.

### Named training batches

The trusted worker normalizes loader items to flat maps:

```python
TrainingBatch(
    inputs={"tokens": tensor, "attention_mask": tensor},
    targets={"next_tokens": tensor},
)
```

- Slot names and shape/dtype contracts are declared in `dataset.json`.
- Values are tensors; arbitrary nested Python containers are not v1.
- One or more top-level Input nodes declare distinct input-binding names. This
  phase deliberately supersedes the current exactly-one-top-level-Input rule.
- Objectives bind exact target slots, for example
  `batch.targets.next_tokens`; missing or incompatible slots fail before the
  epoch loop.
- Empty targets are allowed only if the compiled objective needs no target.
- The worker moves normalized tensors to the selected device.

This represents the ordinary pair as named singleton maps and represents an
autoregressive pair by slicing the same sequence into `inputs.tokens` and
`targets.next_tokens`, without a dataset-type special case.

### Shared dataset runtime and transport

Built-in and project datasets use the same versioned manifest, definition,
parameter, batch and `build(parameters, context)` contract. Trust and storage
differ: built-ins remain baked into the worker image; project Python is
browser-supplied and imported only by the isolated worker.

```text
project dataset directory
    │ validate declarative closure in browser
    v
complete bounded archive upload ─> digest + authenticated ownership
    │                                │
    └──────── opaque reference <─────┘
                     │ selected training job
                     v
          read-only worker-container mount
                     │ fixed loader imports dataset.py
                     v
          named TrainingBatch + compiled bindings
```

FastAPI validates metadata, confinement, size and digest but never imports the
entrypoint. Training requests contain an opaque dataset reference and typed
parameters, never Python import targets or filesystem paths. Upload v1 is one
complete bounded archive per digest with progress and terminal failure; a
failed upload creates no job, and a failed submission does not delete a valid
owned archive.

## Task graph

### Phase 1 and mandatory gate

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [T01](tasks/T01-project-workspace-filesystem.md) | frontend | — | T03 | project workspace adapter/tests | Writable create/open/read/write boundary |
| [T02](tasks/T02-project-first-editor-shell.md) | frontend | T01 | T03 | app shell, toolbar, persistence tests | Startup chooser, title and autosave |
| [T03](tasks/T03-stereotype-authoring-domain.md) | packages | — | T01, T02 | authoring domain/tests | Valid definitions and editable templates |
| [T04](tasks/T04-stereotype-manager-ui.md) | frontend | T03 | — | stereotype UI/tests | Parameter mini-forms and manager |
| [T05](tasks/T05-project-package-runtime-integration.md) | integration | T01-T04 | — | runtime/filesystem seams/tests | Transactional resource creation and activation |
| [T06](tasks/T06-real-interface-verification.md) | verification | T05 | — | browser tests and phase-one evidence | Hard QA gate before datasets |

T01 and T03 are the unconditional parallel pair. T02 may run with T03 after
T01 settles the session API. Phase 2 is blocked until T06 succeeds.

### Phase 2 and closure

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [T07](tasks/T07-dataset-contracts-and-manifest-v2.md) | architecture | T06 | — | shared schemas/contracts/tests | Manifest v2, named batch and dataset contracts |
| [T08](tasks/T08-named-graph-training-bindings.md) | frontend/compiler | T07 | T09, T10 | graph/compiler binding seams/tests | Named Input and objective validation |
| [T09](tasks/T09-unified-built-in-datasets.md) | backend | T07 | T08, T10 | dataset runtime/registry/tests | Built-ins on shared declarative contract |
| [T10](tasks/T10-project-dataset-authoring.md) | frontend | T07 | T08, T09 | dataset authoring/workspace UI/tests | Project dataset form and files |
| [T11](tasks/T11-project-dataset-upload-and-storage.md) | backend/security | T07, T09 | — | upload API/store/controller/tests | Bounded owned archive and opaque reference |
| [T12](tasks/T12-project-dataset-training-integration.md) | integration | T08-T11 | — | training UI, worker, job integration/tests | Built-in/project selection and execution |
| [T13](tasks/T13-final-dataset-verification.md) | verification | T12 | — | browser/E2E tests, KB and plan evidence | Full user-flow proof and initiative closure |

T08, T09 and T10 may run in parallel only after T07 freezes their shared
schema. T11 owns transport/storage; T12 owns the first cross-boundary wiring.

## Integration and review gates

- T05 uses the existing staged package-scope seam and proves rollback at every
  filesystem/runtime boundary. No partial manifest, stale Fiber, palette item
  or unowned directory may remain.
- Removal of the global installer is traced through every caller; no dormant
  IndexedDB ownership model or dead callback remains.
- T06 proves New/Open, autosave ordering, title, identity stereotype, reopen,
  bundle and MCP parity in the real UI. Its failure blocks T07.
- T07 freezes serialization and compatibility before parallel phase-two work.
- T08 validates graph input and objective slot bindings before an epoch loop.
- T09 proves MNIST, AutoencoderMNIST and Enron retain behavior after migration.
- T11 proves size cap, digest, ownership, path/symlink confinement and that
  malformed project code is never imported by FastAPI.
- T12 injects upload, submission, worker-import and batch-contract failures;
  errors remain scoped and no fallback executes project code on the host.
- T13 covers a built-in dataset, a project dataset, multiple named inputs and
  an autoregressive input/target pair through the real supported interfaces.

## Acceptance criteria

### Phase-one QA gate

- [ ] Startup shows New/Open and no diagram before a successful selection.
- [ ] New chooses a parent, safely creates the model-ID child and bootstraps the
      normal initial Input only after core readiness; Open retains write access.
- [ ] The editor shows `manifest.name`; Save JSON, Load JSON and Load bundle are
      absent; ordered autosave exposes saving, saved and failed states.
- [ ] The Stereotypes manager exposes core plus current-project packages and
      supports canonical parameter mini-forms including `position`.
- [ ] An authored layer writes four files, updates the manifest, activates
      without reload, preserves Lua tensor identity and builds PyTorch Identity.
- [ ] Permission, validation, write and activation failures preserve the prior
      committed workspace/runtime or emit an exact fatal rollback diagnostic.
- [ ] Browser-backed MCP observes the same graph, catalog and bundle.
- [ ] T06 passes before any dataset implementation begins.

### Phase-two completion

- [ ] A project dataset form creates a valid directory, exhaustive manifest
      entry, editable Python scaffold, named slots and project-local `data/`.
- [ ] Standard and project datasets appear in one selector and use one
      declarative form/batch contract.
- [ ] Built-in dataset regressions pass after migration; requests no longer
      expose Python import targets.
- [ ] Flat named input/target maps support singleton pairs, multiple inputs and
      an autoregressive pair with preflight shape/dtype/slot validation.
- [ ] Project archives are bounded, content-addressed, ownership-scoped and
      mounted read-only; project Python executes only in the worker container.
- [ ] Jobs record exact dataset ID, version and digest; upload and submission
      have separate, recoverable failure semantics.
- [ ] The UI states the configured size limit and does not imply support for
      large, resumable or external datasets.
- [ ] T13 proves the complete supported user journey and then updates current
      knowledge, marks tasks complete and archives the initiative.

## Validation expected during implementation

Each task runs its narrow tests first. Phase gates additionally run the
relevant package checks, backend fast tests, integration flows and real browser
journeys specified in T06 and T13. `git diff --check` and `git status --short`
remain required before handoff. Exact commands may evolve with implementation;
task evidence records the commands actually run rather than historical counts.

## Knowledge and archive impact

- Keep both accepted decisions linked above authoritative.
- Phase 1 removes current claims that IndexedDB/global installation is a
  supported ownership model while preserving the still-used Cordis lifecycle.
- Phase 2 updates the model-package, remote-training, dataset, graph-input and
  objective contracts to the shared named-batch boundary.
- T06 retains phase-one evidence without archiving. Only T13 may align final
  current knowledge and move this plan to completed plans.
