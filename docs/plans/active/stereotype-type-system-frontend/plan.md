---
id: stereotype-type-system-frontend
kind: plan
status: in_progress
updated: 2026-08-22
areas:
  - frontend
  - type-system
  - stereotypes
  - testing
---

# Reference-compatible frontend stereotype type system

## Goal

Build a new frontend-owned type system whose observable package activation,
Lua inference, tensor types, dtype behavior, composition, and diagnostics match
the `stereotype-lab` oracle. Implement reference-first and prove every slice
with shared deterministic scenarios. The current milestone proves three model
families; whole-graph differential fuzzing remains the next frontend milestone.
Stop before backend implementation.

## Architecture discovery

| Concern | Current NNModelling owner | Relevant symbols |
| --- | --- | --- |
| Graph and subflows | `front-end/src/core/DiagramCore.ts`; containment through Svelte Flow `parentId` | `DiagramCore`, graph mutations, `nodes`, `edges` |
| Reactive inference cycle | `front-end/src/Diagram.svelte.ts` | `Diagram.refreshTypes`, `Diagram.typeResult`, `onGraphChanged` |
| Legacy tensor model and inference | `front-end/src/conversion/tensortypes.ts`, `front-end/src/conversion/typeEngine.ts` | `TensorType`, `TypeResult`, deprecated `TypeEngine.infer` |
| Diagnostics and presentation | `front-end/src/conversion/typeDiagnostics.ts`, `front-end/src/nodes/CustomNode.svelte`, `front-end/src/components/Sidebar.svelte` | `getNodeDiagnosticSummary`, node indicator, diagnostic list |
| Stereotype loading | `front-end/src/core/StereotypeCore.ts` and repository `Stereotypes/` | `StereotypeCore.loadFromDirectory`, `import.meta.glob`, filename-derived identity |
| Compilation and ordered joins | `front-end/src/conversion/nnTree.ts` | `NNTree`, `orderJoinInputs`, `getPythonClassName` |
| Save/load | `DiagramCore.exportToJson`, `DiagramCore.importFromJson`, `front-end/src/utils.ts` | `handleSaveModel`, `handleLoadModel` |
| Browser/backend boundary | frontend training APIs and compiled NNTree JSON | frontend sends serialized NNTree/configuration; no inference package protocol exists |
| Current Python construction | `converted/src/convert.py`, `converted/src/net/`, `converted/src/ops/` | Hydra targets and frontend-emitted `pythonClassName`; no package `pytorch.py` loader |

The live browser's `DiagramCore` remains the only graph authority. The new
type-system host consumes snapshots/adapters over that state; it must not own a
second mutable graph.

## Mapping to the reference

| Reference component | NNModelling destination |
| --- | --- |
| `TensorType`, canonical dtypes, semantic `TypeResult` | new `front-end/src/type-system/semantic/` |
| Manifest/definition validation and parameter resolution | new `front-end/src/type-system/packages/` |
| `PackageLoader`, registry, activation leases and Cordis fibers | new frontend `TypeSystemHost` |
| `LuaInferenceRuntime` and tensor standard library | new `front-end/src/type-system/lua/` using Wasmoon initially |
| `packages/core/<name>/` | repository `stereotype-packages/core/<name>/` |
| graph-independent inference contexts | `DiagramCore` read adapter and graph inference driver |
| structured diagnostic cause and context frames | semantic diagnostics plus editor-only node-location adapter |
| black-box oracle protocol | test-only runner under `front-end/tests/differential/` |
| Python runtime and package `pytorch.py` | **da vedere ancora; excluded from this initiative** |

## Mandatory reference-first implementation

Agents must copy or adapt as much implementation and test code as practical
from the pinned `stereotype-lab` checkout. Writing a parallel implementation
from memory is not an acceptable default.

| NNModelling concern | Reference sources to inspect and prefer copying |
| --- | --- |
| Tensor and result contracts | `src/tensor-type.ts`, `src/type-inference.ts` |
| Package schema and resolution | `src/packages/types.ts`, `validation.ts`, `semver.ts`, `path.ts` |
| Catalog, registry, leases and Cordis activation | `src/packages/catalog.ts`, `registry.ts`, `loader.ts`, related tests in `src/packages/core.test.ts` |
| Lua isolation and tensor library | `src/lua/lua-inference-runtime.ts` and `.test.ts` |
| Core package semantics | matching `packages/core/<name>/` directory plus `src/packages/standard-library.test.ts` and `embedding.test.ts` |
| Nested composition | `src/models/`, `src/models/subflow-models.test.ts`, repeat and horizontal-repeat packages |
| Differential contract | `design/testing/01-reference-oracle-and-differential-fuzzing.md` |

Every task handoff must contain a reuse ledger with reference source, local
destination, and one of `copied`, `adapted`, or `not used` with a reason. The
allowed reasons for substantial adaptation are browser resource delivery,
`DiagramCore`/Svelte integration, or a documented code/spec conflict. The
normative design wins over copied code.

Reference packages should remain byte-identical in product mode wherever the
NNModelling package contract does not require a deliberate difference. This
reduces drift, but does not replace black-box comparison and independent
properties because copied code can preserve correlated bugs.

## Gaps and conflicts

- The deprecated engine interprets central shape/join/subflow actions. The new
  engine must execute package-owned Lua and must not add a package-ID switch.
- Legacy dimensions include constraint patterns, computed expressions,
  wildcards and unification. Reference dimensions are nominal string/number
  values with no constraint solver.
- Legacy dtype is an open string and uses `unknown`; the reference uses a
  closed canonical vocabulary and requires a dtype on every semantic tensor.
- Current stereotype kind and identity come from categories, paths and names.
  The reference uses `input`, `layer`, `loss`, `join`, and `subflow`, plus a
  stable manifest ID and independent version.
- Current errors, warnings, suggestions and `blockedBy` data are flat editor
  structures. Reference semantics require expected errors to preserve an inner
  cause and compositional context, separately from runtime faults.
- Saved nodes identify stereotypes mainly by display name and contain legacy
  parameter wrappers. New nodes must save exact `{id, version, name}` and may
  use a deliberately incompatible format.
- `nnTree.ts` emits `pythonClassName`; the future backend must instead resolve
  trusted package factories independently.
- The reference implementation currently converts some thrown Lua/package
  faults into string-valued inference errors in `src/packages/loader.ts`, and
  its structured diagnostic target is not implemented yet. The normative
  design wins: NNModelling must keep faults distinct and implement structured
  diagnostics even if interim oracle comparisons use agreed messages.

## Scope

- Introduce an isolated frontend semantic model, Cordis host, browser package
  resource adapter, package registry/leases, and sandboxed Lua runtime.
- Add reference core packages one vertical slice at a time under
  `stereotype-packages/core/`.
- Infer locally in incomplete graphs and classify whole-graph completeness by
  exactly one terminal node.
- Integrate semantic results, dtypes, structured diagnostics, and package
  identity with the editor without changing `DiagramCore` ownership.
- Add deterministic black-box comparison first, then schema-aware differential
  generation, shrinking, and retained regressions.
- Run the original pinned Bun suite in the reference checkout and port every
  frontend-semantic case into the NNModelling candidate before declaring
  reference-suite parity.
- Differential-fuzz complete graph semantics, including topology, ordered
  handles, package selections, parameters, dtypes, nested subflows and
  structured failure context.
- End frontend coexistence before backend work: require package identity for
  every frontend node, remove the deprecated engine and legacy stereotypes,
  and make compilation explicitly unavailable until the package backend exists.

## Non-goals

- Backend or PyTorch package loading, module construction, training, or loss
  target delivery.
- Package manager, installer, version solver, lockfile, arbitrary discovery,
  hot reload, Python sandbox, or user package distribution.
- Dtype promotion, implicit casts, constraints over symbolic dimensions,
  partial semantic tensor types, stable diagnostic codes, or multiple causes.
- Automatic conversion of saved legacy diagrams or automatic recreation of
  legacy stereotypes.

## Decisions and invariants

The durable contract is
[`../../../knowledge/decisions/stereotype-type-system-migration.md`](../../../knowledge/decisions/stereotype-type-system-migration.md).
In particular:

- each stereotype is one package and one Cordis plugin;
- every new saved node stores exact package ID/version plus display name;
- inference never calls Python or PyTorch;
- unresolved editor state is not a fake tensor or fake dtype;
- expected diagnostics and faults are disjoint;
- package loading and graph traversal remain data-driven;
- join order comes from `targetHandle`;
- old project compatibility is intentionally not a completion constraint.

## Contracts and control flow

```text
bundled package resources
        |
        v
TypeSystemHost (Cordis context, registry, leases)
        |
        +--> one isolated Lua runtime per active package
        |
DiagramCore read adapter --> local graph scheduler --> package inference
        |                                            |
        |                                            v
        +<-- editor state/annotations <----- semantic result or fault
                                                     |
                                                     v
                                      black-box differential adapter
```

Production imports stop at the left side of the oracle boundary. Tests launch
the reference and candidate as independent processes and compare canonical
wire data.

## Task graph

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [T01](tasks/T01-input-boundary.md) | `frontend` | — | — | new type-system host, `core.input`, focused tests | One package crosses bundled resources, Cordis, Lua, editor adaptation, and deterministic oracle comparison. |
| [T02](tasks/T02-local-graph-inference.md) | `frontend` | `T01` | — | graph driver, new node identity/persistence, `core.fork` | `Input -> Fork` and resolvable regions of incomplete graphs infer without a second graph. |
| [T03](tasks/T03-structured-diagnostics.md) | `frontend` | `T02` | — | diagnostic model/adapter/UI, `core.linear` | Expected mismatch and runtime fault are distinct and rendered from structured data. |
| [T04](tasks/T04-joins.md) | `frontend` | `T03` | — | join scheduling, `core.add`, `core.concat` | Ordered multi-input inference matches the oracle without central package cases. |
| [T05](tasks/T05-subflow-composition.md) | `frontend` | `T04` | — | nested graph adapter, repeat packages | Sequential/parallel subflows preserve inner causes and add iteration/branch/reference context. |
| [T06](tasks/T06-dtype-and-loss.md) | `frontend` | `T05` | — | dtype controls/display, loss handling, remaining reference core packages | Canonical dtype and `loss` semantics are schema-driven and oracle-compatible. |
| [T07](tasks/T07-differential-gate.md) | `testing` | `T06` | — | reference-suite port and test-only black-box protocol | The reference suite is run and a versioned independent-process protocol compares candidate and oracle. |
| [T08](tasks/T08-graph-differential-fuzzing.md) | `testing` | `T07` | — | three deterministic model scenarios and editor fixtures | Transformer, variational-autoencoder and ResNet graphs produce identical canonical observations; generative fuzzing is deferred. |
| [T09](tasks/T09-editor-package-ui-cutover.md) | `frontend` | `T08` | — | sidebar, package picker, schema controls and editor diagnostics | Package nodes are created and edited from active definitions; dtype choices, output types and diagnostics come only from the new engine. |
| [T10](tasks/T10-package-only-frontend-contract.md) | `frontend` | `T09` | — | graph types, Diagram, UI, import/export | Every frontend node and editor path is package-only; no coexistence discriminator remains. |
| [T11](tasks/T11-browser-rpc-and-fixture-cutover.md) | `frontend` | `T10` | — | Browser RPC, examples, fixtures, manifests | Automation, persistence and validation use the same package contract; compilation is explicitly unavailable. |
| [T12](tasks/T12-delete-legacy-type-system.md) | `frontend-testing` | `T11` | — | legacy deletion, CI guard, differential gate | Deprecated code/data/tests are physically gone and the pinned oracle is the only type-semantic authority. |

Tasks remain sequential because each extends the same semantic host and graph
adapter. Every task is a reviewable vertical slice and must leave the previous
slice's tests green.

## First vertical slice

T01 is intentionally limited to `core.input` because its zero-input topology,
shape parameter, canonical dtype, package identity, and missing PyTorch
entrypoint exercise the new architectural boundary without requiring graph
traversal or composition.

- **Precise scope:** create the frontend Cordis host; activate one bundled
  package as one plugin; load and run its Lua entrypoint in an isolated Wasmoon
  state; convert the successful result into the new editor type state; release
  the lease; compare one canonical request with the independent oracle.
- **Probable files:** `front-end/package.json`, workspace lockfile,
  `front-end/src/type-system/**`, `stereotype-packages/core/input/**`, and
  `front-end/tests/differential/**`.
- **Reference starting point:** copy/adapt `src/tensor-type.ts`,
  `src/type-inference.ts`, the minimal package loader/validation files,
  `src/lua/lua-inference-runtime.ts`, `packages/core/input/`, and their focused
  cases from `src/packages/core.test.ts`, `standard-library.test.ts`, and
  `src/lua/lua-inference-runtime.test.ts`.
- **Excluded:** graph scheduling, edges, subflows, UI controls, joins, loss,
  backend, legacy engine changes, arbitrary package discovery, and fuzzing.
- **Acceptance:** `core.input` with `shape: ["B", 32]` and `float32` produces
  exactly the oracle tensor; missing required shape is unresolved before Lua;
  a curated broken Lua fixture is a runtime fault rather than an expected
  error; disposal unregisters the package and destroys its Lua state.
- **Rollback:** the slice is additive and isolated. Reverting the dependency
  additions plus `front-end/src/type-system/`, the one package directory, and
  its tests restores the previous application without data migration.

## Integration and review gates

- No new code path branches on `core.input`, `core.linear`, or another package
  ID to infer a type.
- No semantic call can receive `unknown`, an unresolved parameter, or an
  incomplete tensor.
- Lua cannot access Cordis, filesystem, network, process APIs, or arbitrary
  services; one package cannot retain mutable state that changes later calls.
- Disposing a final lease removes all Cordis-owned registrations exactly once.
- Graph inference reads `DiagramCore` state and preserves containment and
  ordered join handles.
- The oracle clone, command, revision, and packages are test-only and absent
  from production bundles.
- Every reference frontend test is either ported with the same observable
  assertions or listed in the reuse ledger with a concrete inapplicability
  reason; no case silently disappears.
- Every frontend slice has at least one canonical request executed against both
  independent processes. Candidate-only unit tests do not count as
  cross-validation.
- A reference code/spec conflict is resolved in favor of normative `design/`
  and captured by a candidate regression.

## Acceptance criteria

- [x] The pinned reference frontend Bun suite passes in `stereotype-lab`.
- [x] Independent candidate/oracle processes compare deterministic Transformer,
  variational-autoencoder and ResNet semantic graphs.
- [x] Product-mode ResNet exercises copied reference primitives plus the
  NNModelling-only convolutional package slice.
- [ ] Every applicable reference test has a candidate counterpart and reuse
  mapping; this remains part of full frontend parity.
- [ ] Differential graph fuzzing covers complete DAGs, invalid mutations,
  subflows, shrinking and retained regressions; explicitly deferred by the
  user until after the three-model milestone.
- [ ] Expected errors, unresolved editor states, and runtime faults are
  observably distinct.
- [ ] New-format nodes persist exact package ID/version and display name.
- [ ] The live editor shows inferred shape and dtype and renders structured
  diagnostic context without package-specific UI switches.
- [ ] The deprecated `TypeEngine`, `StereotypeCore`, `Stereotypes/`, legacy
  wrappers, and their semantic tests no longer exist.
- [ ] A repository guard rejects reintroduction of legacy symbols or saved
  frontend nodes without exact package identity.
- [ ] The pinned independent oracle is the sole type-semantic acceptance
  authority; differential fuzzing and shrinking pass before frontend completion.
- [ ] No backend implementation has begun.

## Final verification

For the current three-model milestone, run from the repository root:

```bash
pnpm --dir front-end test:type-system:models
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end build
git diff --check
```

In the live editor, load the generated Transformer, variational-autoencoder and
product ResNet diagrams. Confirm the package scheduler reports exactly one
terminal, every node succeeds, and the terminal shape/dtype matches the
deterministic scenario. The complete diagnostic-composition and schema-driven
editing workflow remains within T03–T06 rather than being claimed by this
milestone.

## Backend: da vedere ancora

No backend design or implementation belongs to this plan. After T08 and the
frontend differential gate pass, future agents must begin from these authoritative
`stereotype-lab` sources:

- `design/stereotype-specification/04-pytorch-runtime.md`;
- `design/stereotype-specification/06-loading-and-lifecycle.md`;
- `design/type-system/03-dtype-system.md`;
- `design/nnmodelling-integration/README.md`;
- `python/stereotype_runtime/models.py`, `validation.py`, `loader.py`,
  `runtime.py`, and `pytorch.py`;
- `packages/core/*/pytorch.py` and `python/tests/`.

The later backend plan must independently inspect NNModelling's then-current
compiler/runtime before choosing its slices.

## Knowledge and archive impact

- Keep the migration decision linked above current as accepted boundaries
  change.
- Keep the legacy tensor contract marked deprecated; archive it only when the
  old engine is deleted in the later overall cutover.
- When this frontend initiative passes its gate, record the final semantic
  protocol and editor-state contract under `docs/knowledge/contracts/`, retain
  only useful minimized divergences/evidence, and archive this plan.
