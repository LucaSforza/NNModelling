---
id: mcp-use-case-parity
kind: plan
status: draft
updated: 2026-08-30
areas: [architecture, frontend, mcp, training, testing]
---

# MCP parity with the modeling and training use cases

## Goal

Make the agent perform all eleven workflows in the accepted
[UML use-case constraint](../../../knowledge/uml/mcp-use-case-parity.md), with
the same domain behavior as the editor. Adapt the existing MCP proxy and expose
shared frontend operations; do not replace the server or duplicate the graph.
The Visual Paradigm source is [nn.vpp](../../../../analysis/uml/nn.vpp).

This is an implementation plan, not an implementation report. The functional
requirements are accepted; the API proposals below remain draft until T01
settles project permission handshakes, capture support, connection routing and artifact delivery. No source
code change or training execution is implied by publishing this plan.

## Current behavior and adaptation map

The findings below come from reading the implementation, not inferring support
from tool names. Detailed evidence is indexed in the
[MCP architecture](../../../knowledge/architecture/browser-mcp.md).

| UML ID / use case | Current implementation | Required adaptation | Task |
| --- | --- | --- | --- |
| T1 — Connect backend | MCP HTTP client reads process URL/token; sidebar performs pairing, renewal and session restoration. | Expose authorized connection lifecycle with visible pending/expired/rejected states; use the selected editor session for the parity workflow. | T04 |
| T2 — Edit training parameters | Sidebar owns local form state; MCP accepts an opaque job object. | Shared inspect/update/config-validation operation covering every sidebar field, visible bidirectionally in UI and MCP. | T04 |
| T3 — Launch training | Sidebar builds and uploads a package bundle before submitting; MCP only forwards `POST /jobs`. | Submit a stable snapshot of the active diagram and configuration through the same bundle preparation/upload path. | T05 |
| T4 — Monitor training | MCP exposes jobs/logs/events, but events await `response.text()` until SSE closes. | Bounded incremental reads with resumable event/log cursors, explicit terminal/error states and cancellation. | T06 |
| T5 — Download wheel | Backend and browser verify/download bytes; MCP has no download operation. | Retrieve the owned artifact, verify manifest/header/body SHA-256 and deliver an accessible file, not only backend metadata. | T06 |
| M1 — Add node | RPC creates package nodes, but omits sidebar default materialization and `wheelAdapters`; schema advertises rejected legacy input and omits `output`. | Reuse the sidebar's package preparation and activated-creation path; align the public schema with supported kinds/options. | T02 |
| M2 — Connect nodes | RPC delegates to `DiagramCore.addEdge`. | Preserve this implementation; prove accepted/rejected handles, join ordering and notification behavior. | T02 |
| M3 — Edit node parameters | MCP schemas require strings; RPC stores values without sidebar conversions. | Preserve typed numbers, booleans, lists/shapes and package references through shared validation and mutation. | T02 |
| M4 — Format view | **Disponi** calls `diagram.autoLayout(direction)`; no MCP/RPC operation exposes it. | Add a thin layout operation for both directions and wait for the visible canvas to settle. | T03 |
| M5 — Screenshot | CDP capture chooses its own page and never requests layout. | Bind capture to the selected MCP tab, perform layout first and return a real browser screenshot after render completion. | T03 |
| M6 — Open a project | Browser project creation/opening exists in `ProjectWorkspaceAdapter`; no corresponding MCP workflow is registered. | Expose New/Open through shared browser project operations with identical UI parameters, directory permissions and activation behavior. | T08 |

### Source seams to change or reuse

- [Project workspace](../../../../front-end/src/project-workspace/index.ts):
  reuse `ProjectWorkspaceAdapter`, `createProjectWorkspace`,
  `selectExistingProject` and the ordered writer. Connect the application-shell
  project lifecycle to MCP without creating a server filesystem owner.
- [server.ts](../../../../mcp-server/src/server.ts): `discoverTools` converts
  Zod schemas to JSON but discards the runtime parser; `CallToolRequestSchema`
  dispatches unparsed arguments. Add validated dispatch and meaningful tool
  descriptions here, not a second tool framework.
- [BrowserRPCHandler.ts](../../../../front-end/src/sync/BrowserRPCHandler.ts):
  graph dispatch, typed parameter mutations and browser service injection.
  Three validation methods return constant success; viewport reporting is
  also synthetic. Do not use these responses as parity/preflight evidence.
- [Sidebar.svelte](../../../../front-end/src/components/Sidebar.svelte),
  [package-ui.ts](../../../../front-end/src/type-system/editor/package-ui.ts)
  and [Diagram.svelte.ts](../../../../front-end/src/Diagram.svelte.ts): reuse
  `initialPackageParameters`, reference handling and `addActivatedPackageNode`.
- [FlowCanvas.svelte](../../../../front-end/src/FlowCanvas.svelte): owns the
  project-scoped diagram, viewport, layout button and conditional training
  sidebar. Own shared workflow services above the sidebar so closing it does
  not disable MCP or destroy its configuration.
- [TrainingSidebar.svelte](../../../../front-end/src/components/TrainingSidebar.svelte),
  [training/api.ts](../../../../front-end/src/training/api.ts),
  [connection.ts](../../../../front-end/src/training/connection.ts) and
  [package-bundle.ts](../../../../front-end/src/training/package-bundle.ts):
  reuse pairing, package resource closure, digest validation and HTTP contracts.
- [remote-training.ts](../../../../mcp-server/src/remote-training.ts) and its
  [tools](../../../../mcp-server/src/tools/remote-training.ts): distinguish
  existing low-level, process-authenticated operations from the new
  selected-editor workflow; never silently switch the owner of an existing call.
- [screenshot.ts](../../../../mcp-server/src/tools/screenshot.ts),
  [chromium-screenshot.ts](../../../../mcp-server/src/chromium-screenshot.ts)
  and [browser-client.ts](../../../../mcp-server/src/browser-client.ts):
  resolve the mismatch between screenshot page selection and RPC tab selection.
- [backend/app.py](../../../../converted/src/backend/app.py): already provides
  owned `/package-bundles`, `/jobs`, `/jobs/{job_id}/logs/tail`,
  `/jobs/{job_id}/events` and `/jobs/{job_id}/package`. Reuse them; no scheduler
  or wheel exporter rewrite.

### Adjacent transition, not a hidden prerequisite

The editor already mounts around a writable project session. However, the
inspected training code still selects `dataset.target` and sends constructor
parameters. The accepted named-batch/project-dataset design is a separate
[project-workspace initiative](../project-workspaces-and-stereotype-authoring/plan.md),
not proof that its dataset phase has landed. Recheck its phase gate at T01 and
integrate through its canonical seams when available. Do not introduce project
dataset authoring or multiple-input semantics here, nor freeze obsolete target
fields as a new permanent MCP contract. Current exactly-one-Input validation
changes only with the coordinated named-input transition.

## Scope and non-goals

Scope includes the eleven workflows, public schema accuracy, truthful errors,
selected-tab coherence, and regression coverage for existing additional tools.
Instantiation means using an existing stereotype, not creating a package.

Out of scope: new deployment transport, MCP UI widgets, a search/execute
catalog redesign, new agent roles, new package/type semantics, stereotype/dataset
authoring, automatic architecture generation, host-Python execution, scheduler
changes, cloud provisioning and removal of tools just because UML omits them.

## Decisions and invariants

- The UML document remains the single functional authority. Keep its original
  `«extend»` notation; its note makes layout-before-screenshot mandatory.
- One browser `DiagramCore` owns the graph, catalog, type diagnostics and
  mutations. MCP holds neither a mirror graph nor a fallback package catalog.
- Follow the accepted [thin-proxy/code-sharing principle](../../../knowledge/uml/mcp-use-case-parity.md#thin-proxy-and-shared-browser-logic):
  maximize reuse of browser domain operations rather than copy their logic
  into MCP. Keep only transport adaptation and protocol validation in tools.
- UI and RPC call shared domain operations; equivalent behavior does not
  require automating DOM clicks. Preserve typed defaults, adapter selections,
  one accepted-mutation notification, undo/redo and ordered project autosave.
- Preserve handle constraints and join ordering by `targetHandle`, including
  subflows and hidden children; do not reimplement topology in tool adapters.
- Preserve [pairing and ownership](../../../knowledge/contracts/pairing.md):
  pending is not connected, renewal retains identity, revocation is distinct
  from forgetting, and tokens never enter tool results, URLs, logs or files.
- Backend jobs and wheel production remain backend responsibilities. Preserve
  [model-package integrity](../../../knowledge/contracts/model-package.md)
  and worker isolation; no admin approval bypass or Python host fallback.
- Resolve tab/project/backend identity once per workflow. Disconnect, project
  switch or session change must not redirect an in-flight operation silently.
- Do not solve compatibility with permanent behavior flags. Existing useful
  tools stay available; any incompatible retirement requires explicit approval.

## Proposed contracts and control flow

These are recommended implementation choices, not newly accepted requirements.
T01 records the final names, payloads and compatibility decisions before code.

```text
MCP tools -> selected-tab BrowserRPCHandler
                         +-> shared project operations -> writable session -> editor
                         +-> shared node operations -> DiagramCore -> UI/autosave
                         +-> shared training controller -> existing TrainingApiClient
                         |                                  -> authenticated backend
                         +-> layout/render readiness -> bound browser capture
```

### Project creation and opening

M6 includes two proposed operations, `create_project` and `open_project`.
Creation accepts an explicit `projectPath` plus the UI form's `id`, `version`,
`name` and optional `description`, with identical defaults/validation. The MCP
path is canonical, absolute and confined to the configured project root;
collision rejection, initialization, activation and ordered writes remain
browser-owned. Opening loads the chosen project's model and declared resources
through the same service used by the UI. Do not replace this with
`import_diagram` or `reset_diagram`, and do not expose handles or paths in
results.

T01 must resolve how the selected browser tab accepts project requests before
an editor/DiagramCore is mounted. T08 owns that application-shell bridge;
graph tools remain unavailable until project activation succeeds. Picker UI
remains available for graphical use, while MCP path mode avoids picker gesture
requirements. Cancellation/denial is not success, and a failed open/switch
preserves the previous project. No path-to-handle conversion or permission
bypass is allowed.

### Modeling and capture

Keep `create_node`, `connect_nodes`, `set_parameter` and `update_parameters`;
repair their schemas and delegate preparation to the browser catalog. Correct
the impossible legacy creation alternative with a clear migration error.
Parse inputs at the public server boundary only after schema parity is fixed,
otherwise currently accepted typed payloads could be broken accidentally.

Propose `format_view({direction})` and extend `capture_screenshot` with a layout
direction, defaulting to the editor's current direction. Capture itself must
invoke the shared layout/readiness operation, so correctness does not depend on
the agent remembering a preceding call. Preserve full-page/hover behavior where
supported; reload must never discard unsaved project state as a capture shortcut.

T01 must prove how the supported browser capture interface identifies the
exact RPC-selected page. A host's screenshot tool is not automatically callable
by the MCP process. Do not substitute canvas PNG export for a browser screenshot
or claim support based on URL matching alone. If capture needs an unavailable
host integration, identify the required adapter and approval before T03 starts.

### Backend connection and complete training configuration

Propose a project/editor-scoped training controller injected into both the
sidebar and RPC handler. Keep secrets private to the connection service; expose
only session status, backend identity, expiry and pairing verification details.
Configuration lives for the editor session; persistence across reloads is an
open product choice, not permission to change the project file format.

Proposed operations: `connect_training_backend`, `get_training_connection`,
`renew_training_connection`, `disconnect_training_backend`,
`get_training_config`, `update_training_config` and `start_training`.
Separate local forgetting from explicit revocation. Pairing returns a pending
result promptly; it does not wait indefinitely or perform approval itself.

T04 must maintain a tested field inventory from the actual sidebar:

| Area | Fields to inspect/update with equivalent meaning |
| --- | --- |
| Dataset | Selection and every descriptor-provided parameter, defaults and requiredness |
| Optimization | Seed, optimizer target/selection, learning rate |
| Trainer | Epochs, accelerator, patience, minimum delta |
| W&B | Project and mode |
| Resources | CPU, RAM, GPU count, GPU RAM, GPU type, node selector |
| Submission | Priority and package-name suffix, including `nnm_` normalization |
| Connection | Backend URL and optional device name; session operations are not training parameters |

Use one canonical typed configuration and one request serializer. UI text input
conversion remains a presentation concern; MCP typed values must not be
stringified. Dataset descriptors govern valid keys and conversion. Do not expose
arbitrary Hydra overrides or promise fields rejected by the backend.

`start_training` uses the active project and selected configuration. It waits
for package readiness, freezes graph/resources/config together, builds the
existing bundle, uploads it under the paired owner, verifies the returned
digest and submits the job. Return the job ID and snapshot/bundle identity.
Upload failure creates no job; ambiguous submission failure is reported without
blind retry that could queue duplicate training. Do not introduce a transaction
manager or a second scheduler to implement this sequence.

### Monitoring, artifact delivery and compatibility gate

Propose bounded `read_training_progress` and `download_training_wheel` operations
for the selected-editor workflow. Progress contains job state, available metrics,
stdout/stderr chunks and separate event/log continuation cursors. Reuse existing
incremental parser and tail endpoints; cap wait time and response size and release
readers on timeout/disconnect. No call waits for training completion or SSE EOF.

Download first reads the owned job manifest, then checks expected digest,
response header and actual bytes. T01 chooses one supported artifact delivery
route with an explicit size bound and safe destination policy. Success requires
an actual accessible verified artifact; a remote path, manifest or browser Blob
URL inaccessible to the agent is insufficient. Never forward a bearer token to
the model to make a download possible.

Keep existing inspection, diagnostics, graph edits, subflows, selection,
query/reset parameters, import/export/reset, tab management, viewport and
low-level training tools unless a separately approved migration replaces them.
Before rerouting any existing HTTP training name, T01 must decide whether its
process-authenticated compatibility contract remains separately documented or
is migrated explicitly. The new parity workflow must not mix these identities.
Constant-success validators and synthetic viewport values must become real
observations where existing services allow it, otherwise explicit unsupported
results. This is not a mandate for a new validation engine.

## Task graph

Tasks are sequential because they share RPC registration and frontend wiring.
Do not parallelize overlapping write scopes without first splitting them.

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [T01](tasks/T01-contracts.md) | architecture | — | — | Plan, narrow contract/evidence documents | Resolve capture, identity, schemas and artifact gates |
| [T08](tasks/T08-project-workflow.md) | integration | T01 | — | Project shell/services, browser bridge, MCP adapters and tests | Create/open the same writable project as the UI |
| [T02](tasks/T02-modeling.md) | integration | T08 | — | Node/parameter seams, MCP dispatch, focused tests | Sidebar-equivalent modeling and truthful validation |
| [T03](tasks/T03-layout-capture.md) | integration | T02 | — | Canvas/RPC/capture adapters and tests | Real selected-tab layout-before-screenshot |
| [T04](tasks/T04-training-session.md) | frontend | T03 | — | Training controller, sidebar, RPC/MCP wiring and tests | Shared authorized session and full configuration |
| [T05](tasks/T05-training-submit.md) | integration | T04 | — | Bundle/submission seams and tests | Train the active project snapshot |
| [T06](tasks/T06-progress-wheel.md) | integration | T05 | — | Progress/download adapters and tests | Bounded monitoring and verified artifact delivery |
| [T07](tasks/T07-parity-verification.md) | integration | T06 | — | Integration tests, evidence and current KB | Prove every UML workflow and preserved capabilities |

T08 is inserted before modeling while retaining the existing task identifiers.

## Integration and review gates

1. T01 closes the open choices above and records approved compatibility changes;
   a missing capture facility blocks that slice, not an invented implementation.
   Project startup routing and directory permission handling must be settled
   before T08; test New/Open without a pre-existing mounted editor.
2. T02 tests through `tools/list` and `tools/call`, not only direct handlers.
   Invalid payloads cannot mutate state; schema corrections precede enforcement.
3. T03 proves both directions, render ordering and two-tab isolation. Viewport
   fit/center without an attached controller cannot report success.
4. T04 proves configuration is available with sidebar closed and updates visible
   when reopened. Switching tabs/projects cancels stale work without leaking
   configuration, tokens or ownership.
5. T05/T06 preserve backend routes unless a concrete missing contract is proven.
   A backend change requires an explicit bounded task and backend package gates;
   it is not silently absorbed into this frontend/MCP plan.
6. T07 distinguishes automated/mock evidence from real authorized browser,
   training and wheel-download evidence. Missing infrastructure or approval is
   an explicit incomplete gate, never a passing mock substitute.

## Acceptance criteria

- [ ] All eleven UML rows have passing public-interface evidence.
- [ ] The agent is associated with every UML use case. New/Open uses the same
      browser operations and creation form fields as the UI, preserves permissions,
      handles collisions/cancellation and activates the correct resource scope.
- [ ] Sidebar and MCP creation/editing agree on defaults, typed parameters,
      references, adapters and supported package kinds, including `output`.
- [ ] Both layout directions match **Disponi** and precede capture of the same
      selected tab; another tab's graph is unchanged.
- [ ] Every current training-sidebar field round-trips UI/MCP/backend correctly.
- [ ] Pairing requires approval; renewal, expiry and ownership errors remain
      visible and no credential appears in outputs or saved evidence.
- [ ] A type-valid active project trains through bundle preparation/upload and
      bounded monitoring; its generated wheel is actually retrieved and verified.
- [ ] Downloaded wheel installs and runs its public `Model` API in a clean
      consumer environment without the repository on `PYTHONPATH`.
- [ ] Additional useful tools remain covered; fake validator/viewport successes
      cannot be mistaken for observations.
- [ ] Undo/redo, project autosave, package scope, handles, hidden subflows and
      backend isolation are preserved.

## Final verification

During implementation, run targeted task checks first, then:

```bash
pnpm --dir mcp-server test
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end guard:package-only
pnpm --dir front-end build
git diff --check
```

T07 specifies the real public-interface journey. Use a disposable project and
an explicitly authorized minimal training job; do not alter an unrelated live
diagram or provision compute to validate documentation. Load the repository
browser workflow skill and use the host-supported browser surface. Runtime
checks above are implementation gates, not claims that writing this plan ran
or passed them.

## Knowledge and archive impact

Link this plan from the UML decision and active initiative index. Keep the UML
diagram unchanged. Update current MCP architecture only when implementation
actually changes; classify unimplemented proposals as such. At completion,
retain useful parity evidence, mark tasks done, update current contracts, and
move the initiative intact to completed plans. Do not copy this status into
another dashboard or revive retired design directories.
