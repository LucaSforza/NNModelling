---
kind: evidence
task: T01
status: ready
updated: 2026-08-30
---

# T01 contract and feasibility evidence

This is the T01 evidence record for the accepted
[MCP use-case constraint](../../../knowledge/uml/mcp-use-case-parity.md). The
UML behavior, ownership boundaries, safety bounds and failure invariants are
agreed. Tool names, result envelopes and the capture adapter remain
implementation choices until verified through the public interface; this
record does not turn an unverified proposal into support.

## Evidence boundary

The pre-T02 real `pnpm --dir mcp-server start` process was initialized over
stdio and returned `tools/list` with **45 tools**. A successful public `tools/call` of
`list_browser_tabs` returned `{tabs: [], activeTabId: null}`. Calls to `ping`
and `set_parameter` returned `isError: true` with
`{"error":{"code":"INTERNAL_ERROR","message":"No browser connected"}}`.
The latter call supplied a numeric value to the then string-advertised
`set_parameter` field and was not rejected at the MCP boundary. This is a
historical pre-T02 observation; current `server.ts` parses every call with its
Zod schema before dispatch.

Unit tests and proxy mocks are not counted as successful workflow evidence.
The current server envelope is the same for every tool: success is one MCP
text content item containing pretty-printed JSON, while a thrown error is one
text item containing `{error:{code,message,details?}}` and `isError: true`.
Browser-proxy output has no declared MCP output schema and is whatever JSON
the browser RPC method returns. Remote-training output is likewise an
undeclared backend JSON value. This absence is part of the current contract
gap, not permission to infer a second data model.

## Historical pre-T02 tools/list catalog

The following is the 2026-08-30 pre-T02 catalog captured from the real server. `R` is
the required input set; all other fields in a row are optional. `object` means
the generated schema permits arbitrary JSON members, exactly as shown by
`zod-to-json-schema`.

### Browser graph, parameters and selection

| Tool | Current input shape (`R`; bounds) | Current output shape |
| --- | --- | --- |
| `connect_nodes` | `source:string(min 1)`, `target:string(min 1)`; `sourceHandle?:string`, `targetHandle?:string` (`R=source,target`) | Browser RPC JSON (undocumented) |
| `create_node` | `position:{x:number,y:number}`; `stereotype?:string`, `package?:{id:string(min 1),version:string(min 1),name:string(min 1),kind:"input"|"layer"|"loss"|"join"|"subflow"}`, `config?:{name?:string,color?:string,width?:number,height?:number,params?:object,inputsCount?:integer>=1,parentId?:string}` (`R=position`; advertised schema omits the refine requiring package/stereotype) | Browser RPC JSON (undocumented) |
| `create_subflow` | `position:{x:number,y:number}`, `label?:string` (`R=position`) | Browser RPC JSON (undocumented) |
| `delete_nodes` | `nodeIds:string[]` (`minItems=1`; `R=nodeIds`) | Browser RPC JSON (undocumented) |
| `disconnect_nodes` | `source:string(min 1)`, `target:string(min 1)`, `targetHandle?:string` (`R=source,target`) | Browser RPC JSON (undocumented) |
| `duplicate_nodes` | `nodeIds:string[]` (`minItems=1`), `offset?:{x:number,y:number}` (`R=nodeIds`) | Browser RPC JSON (undocumented) |
| `move_nodes` | `positions:{id:string,x:number,y:number}[]` (`minItems=1`; `R=positions`) | Browser RPC JSON (undocumented) |
| `set_parameter` | `nodeId:string(min 1)`, `key:string(min 1)`, `value:string` (`R=all`) | Browser RPC JSON (undocumented; handler can carry non-string values) |
| `update_parameters` | `nodeId:string(min 1)`, `params:Record<string,string>` (`R=all`) | Browser RPC JSON (undocumented; handler can carry non-string values) |
| `reset_parameters` | `nodeId:string(min 1)`, `keys?:string[]` (`R=nodeId`) | Browser RPC JSON (undocumented) |
| `query_parameters` | `nodeId:string(min 1) | string(min 1)[]` (`R=nodeId`) | Browser RPC JSON (undocumented) |
| `clear_selection` | `{}` | Browser RPC JSON (undocumented) |
| `get_selection` | `{}` | Browser RPC JSON (undocumented) |
| `select_all` | `{}` | Browser RPC JSON (undocumented) |
| `select_nodes` | `nodeIds:string[]`, `mode?:"replace"|"add"|"remove"` (default `"replace"`; `R=nodeIds`) | Browser RPC JSON (undocumented) |

### Canvas, validation, serialization and inspection

| Tool | Current input shape (`R`; bounds) | Current output shape |
| --- | --- | --- |
| `center_view` | `x?:number,y?:number,zoom?:number` | Browser RPC JSON (undocumented) |
| `fit_view` | `nodeIds?:string[]` | Browser RPC JSON (undocumented) |
| `get_canvas_state` | `{}` | Browser RPC JSON (currently synthetic in the handler) |
| `validate_connections` | `{}` | Browser RPC JSON (currently constant success) |
| `validate_graph` | `{}` | Browser RPC JSON (partial graph validation) |
| `validate_parameters` | `{}` | Browser RPC JSON (currently constant success) |
| `validate_subflows` | `parentId?:string,maxDepth?:integer>0` (default `10`) | Browser RPC JSON (currently constant success) |
| `export_diagram` | `{}` | Browser RPC JSON (undocumented serialized diagram) |
| `import_diagram` | `json:string(min 1)` (`R=json`) | Browser RPC JSON (undocumented) |
| `get_edges` | `nodeId?:string` | Browser RPC JSON (undocumented) |
| `get_graph` | `{}` | Browser RPC JSON (undocumented graph snapshot) |
| `get_node` | `nodeId:string(min 1)` (`R=nodeId`) | Browser RPC JSON (undocumented) |
| `get_package_diagnostics` | `{}` | Browser RPC JSON (undocumented diagnostics) |
| `get_subflow` | `parentId:string(min 1)` (`R=parentId`) | Browser RPC JSON (undocumented) |
| `get_type_info` | `nodeId?:string(min 1),refresh?:boolean` | Browser RPC JSON (undocumented type result) |
| `graph_statistics` | `{}` | Browser RPC JSON (undocumented) |
| `list_stereotypes` | `category?:string` | Browser RPC JSON (undocumented browser catalog) |
| `ping` | `{}` | Browser RPC JSON (normally `{nodeCount,edgeCount}`) |
| `reset_diagram` | `{}` | Browser RPC JSON (undocumented) |

### Browser-tab and screenshot tools

| Tool | Current input shape (`R`; bounds) | Current output shape |
| --- | --- | --- |
| `list_browser_tabs` | `{}` | `{tabs:TabInfo[],activeTabId:string|null}` where each `TabInfo` is `{id,nodeCount:number,edgeCount:number,connectedAt:number}` |
| `select_browser_tab` | `tabId:string(min 1)` (`R=tabId`) | `{success:true,selectedTab:string}` or thrown error |
| `capture_screenshot` | `outputPath?:string(min 1),pageUrl?:string(uri),fullPage?:boolean,reloadPage?:boolean,hoverNodeId?:string(min 1)` | `{success:true,outputPath:string,pageId:string,pageUrl:string,title:string,width:number|null,height:number|null,bytes:number}` |

`capture_screenshot` currently selects a Chromium DevTools page by URL (or by
the only local page), writes it with an overwriting `writeFileSync`, and does
not consult `activeTabId`. `pageId` is a DevTools target ID, not the MCP
`tab_N` ID.

## Current post-T06 tools/list snapshot

The later T07 transport run observed **54 tools** after T02, T04, T05 and T06.
The current public boundary parses Zod inputs before handlers. The modeling
surface is package-only: `create_node` requires `package` identity, accepts
`output` kind, typed `parameters`, presentation/default fields and
`wheelAdapters`; `set_parameter.value` and `update_parameters.params` accept
typed JSON values. `validate_parameters` performs the browser's parameter
check, while `validate_connections` and `validate_subflows` return explicit
`supported:false` results because no standalone authoritative checks are
exposed. `format_view` is still absent, and the screenshot path remains the
unbound URL/CDP implementation described above.

The complete post-T06 transport observations, including the 54-tool count and
public invalid-input checks, are retained in
[`evidence/parity.md`](evidence/parity.md). This summary is the current
contract snapshot; the table above remains historical evidence.

### Process-authenticated remote-training tools

| Tool | Current input shape (`R`; bounds) | Current output shape |
| --- | --- | --- |
| `list_training_datasets` | `{}` | Backend JSON array (undeclared) |
| `list_training_compute_units` | `{}` | Backend JSON array (undeclared) |
| `submit_training_job` | `job:Record<string,unknown>` (`R=job`; description says complete job JSON) | Backend job JSON (undeclared) |
| `list_training_jobs` | `{}` | Backend JSON array (undeclared) |
| `get_training_job` | `jobId:string(min 1)` (`R=jobId`) | Backend job JSON (undeclared) |
| `get_training_job_logs` | `jobId:string(min 1)` (`R=jobId`) | Backend JSON object (undeclared) |
| `get_training_job_events` | `jobId:string(min 1)`, `after?:string(min 1)` (`R=jobId`) | Backend JSON array (undeclared); current client reads until SSE closes |
| `cancel_training_job` | `jobId:string(min 1)` (`R=jobId`) | Backend job JSON (undeclared) |

These names remain process-authenticated compatibility operations. They use
`NNM_BACKEND_URL` and optional `NNM_BACKEND_TOKEN` in the MCP process and are
not silently rerouted to a browser-selected connection.

## Training routing and provenance

Selected-editor session/configuration/submission operations use:

```text
MCP -> BrowserRPCHandler -> TrainingController -> paired browser API -> backend
```

The current `read_training_progress` and `download_training_wheel` public tools
still use the compatibility path:

```text
MCP -> RemoteTrainingClient -> NNM_BACKEND_URL/TOKEN -> backend
```

They must not be described as selected-editor operations until distinct tools or
browser RPC routes exist. Every future result must expose its route/provenance
and ownership-safe identity, while never returning a bearer token.

## Sidebar field inventory and session contract

The current `TrainingSidebar` has these state fields and defaults. Dataset
parameters are dynamic and must be sourced from the selected descriptor rather
than a hard-coded list.

| Area | Field | Current UI/default and wire meaning |
| --- | --- | --- |
| Connection | `backendUrl` | Text URL; default `VITE_TRAINING_API_URL` or `http://127.0.0.1:8000`; normalized to HTTP(S) origin/path without credentials, query or fragment |
| Connection | `deviceName` | Optional text, max 80 characters |
| Dataset | `selectedDataset` | Descriptor `target` selected from `/datasets` |
| Dataset | `datasetParams` | Descriptor parameters; UI strings canonicalized by descriptor type before submission |
| Dataset | `seed` | Number input, default `42`, integer |
| Optimization | `optimizerTarget` | Text, default `torch.optim.Adam` |
| Optimization | `learningRate` | Number input, default `0.001`, positive float |
| Trainer | `maxEpochs` | Number input, default `20`, integer |
| Trainer | `accelerator` | Text, default `auto`; accepted wire values `auto`, `cpu`, `cuda` |
| Trainer | `patience` | Number input, default `3`, integer |
| Trainer | `minDelta` | Number input, default `0`, float |
| W&B | `wandbProject` | Text, default `NeuralNetworks` |
| W&B | `wandbMode` | Text, default `disabled`; accepted wire values `disabled`, `offline`, `online` |
| Resources | `cpu` | Number input, default `4`, non-negative integer |
| Resources | `memoryGb` | Number input, default `8`, positive number |
| Resources | `gpu` | Number input, default `0`, non-negative integer |
| Resources | `gpuMemoryGb` | Optional number input, empty by default |
| Resources | `gpuType` | Optional text selector, empty by default |
| Resources | `node` | Optional text selector, empty by default |
| Submission | `priority` | Number input, default `0` |
| Submission | `packageSuffix` | Optional `[A-Za-z][A-Za-z0-9_]*`; submitted package name is `nnm_<suffix>` |

Connection status is separate from training configuration. The browser
currently observes `disconnected`, `checking`, `pending`, `active`, `expired`,
`rejected` and `error`; pending pairing returns a verification code and is not
connected. Tokens remain in the browser-only connection store and never appear
in MCP results, URLs, logs, artifacts or project files.

The parity controller is editor-session scoped (one controller shared by
the sidebar and RPC handler), survives sidebar close, and is invalidated on
project/tab switch or disconnect. Configuration is not added to `model.json`;
reload persistence is not part of this freeze. Browser connection restoration
may remain browser-local, but MCP exposes only backend identity, status and
expiry. Explicit `disconnect_training_backend({revoke:boolean})` distinguishes
local forgetting from backend revocation.

## Proposed parity operations pending public verification

Existing useful tools remain available. The following names and typed shapes
are the working proposal for implementation. The agreed requirements are the
observable behavior, ownership, bounds and error invariants; names and the
success envelope remain open until the public tools are routed and verified.
`pending` is never reported as success and never carries a secret.

| Workflow | Public operation and input | Observable result and failure behavior | Browser/backend seam |
| --- | --- | --- | --- |
| T1 | `connect_training_backend({baseUrl:string,deviceName?:string})`; `get_training_connection({})`; `renew_training_connection({})`; `disconnect_training_backend({revoke?:boolean})` | Connect/renew returns promptly with `pending`, request ID, verification code and expiry (no token); later status is `active`, `expired`, `rejected` or `error`. Invalid URL, cancellation, rejection and expiry are distinct. Missing/expired session yields `BACKEND_NOT_CONNECTED`. | Shared browser `TrainingController` over `TrainingApiClient` pairing/session routes; no change to process tools. |
| T2 | `get_training_config({})`; `update_training_config({patch:TrainingConfigPatch})`; patch contains typed dataset selection/descriptor params, seed, optimizer, trainer, W&B, resources, priority and package suffix | Return complete canonical typed config and descriptor validation diagnostics. Unknown dataset keys, invalid enum/range/selector or stale project identity fail before mutation with `INVALID_CONFIGURATION`; no opaque Hydra override. | Shared controller used by `TrainingSidebar` and RPC; descriptor conversion stays in browser. |
| T3 | `start_training({})` (uses active project, graph and session config; no raw job JSON) | After package runtime readiness and one frozen graph/config/resource snapshot, returns `{status:"ok",jobId,bundleRef,snapshotDigest}`. Upload failure creates no job; ambiguous submit returns `SUBMISSION_UNKNOWN` and is never blindly retried. | Browser DiagramCore/package export → existing `uploadPackageBundle` → authenticated `/jobs`; backend remains owner. |
| T4 | `read_training_progress({jobId,eventCursor?:string,stdoutOffset?:integer>=0,stderrOffset?:integer>=0,waitMs?:integer 0..30000,maxBytes?:integer 1..262144})` | Bounded `{status:"ok",job:{state,...},metrics,stdout:{text,offset,nextOffset,reset},stderr:{...},eventCursor,nextEventCursor}`; terminal states are explicit. Timeout returns a resumable cursor, never waits for SSE EOF. Unknown job/ownership, disconnect and cursor reset are explicit errors. | Current public tool is process-authenticated `RemoteTrainingClient`; a selected-editor variant is not yet routed. |
| T5 | `download_training_wheel({jobId,destinationPath?:string})` | Reads the owned manifest, verifies header and body SHA-256, then writes a local artifact and returns `{status:"ok",artifact:{kind:"wheel",path,mediaType:"application/octet-stream",bytes,sha256}}`. Max 256 MiB; default is a server-created 0600 file in its private temp artifact directory. A supplied path must be within that directory (or an explicitly configured artifact root), have a sanitized basename, and be created exclusively—existing files are `ARTIFACT_EXISTS`. Missing/malformed/mismatched digest, ownership, size or write errors fail closed. | Current public tool is process-authenticated `RemoteTrainingClient`; selected-editor download is missing. |
| M1 | Existing `create_node({package:{id,version,name,kind},position?:{x,y},parameters?:Record<string,unknown>,name?:string,parentId?:string})` | Returns `{status:"ok",nodeId,...}` after the browser materializes sidebar defaults and adapter/reference values. `stereotype` is removed from the release schema; callers using it get `INVALID_ARGUMENT` with migration guidance, not a second creation path. | `BrowserRPCHandler.handleCreateNode` plus browser catalog, `initialPackageParameters` and `addActivatedPackageNode`. |
| M2 | Existing `connect_nodes({source,target,sourceHandle?,targetHandle?})` | `{status:"ok",edgeId,source,target}`; missing nodes, invalid handles, capacity and containment are truthful errors. `targetHandle` order controls joins. | `BrowserRPCHandler` → `DiagramCore.addEdge`. |
| M3 | Existing `set_parameter({nodeId,key,value:unknown})` and `update_parameters({nodeId,params:Record<string,unknown>})` | Typed values round-trip in `{previousValue,currentValue}` / updated lists; unknown keys, wrong declared type and missing node fail before mutation. | Shared browser parameter conversion/validation, not string coercion in MCP. |
| M4 | New `format_view({direction:"horizontal"|"vertical"})` | `{status:"ok",direction,layoutVersion}` only after `diagram.autoLayout(direction)` and visible render settle; missing active editor returns `NO_ACTIVE_PROJECT`. | New thin RPC case over the editor's `Disponi` operation. |
| M5 | Existing `capture_screenshot({fullPage?:boolean,hoverNodeId?:string,layoutDirection?:"horizontal"|"vertical",destinationPath?:string})` | Must invoke layout/readiness first and return a verified PNG artifact with path, byte count and SHA-256. Capture errors, missing tab, render timeout and artifact collision are explicit. | Requires the capture binding in the next section; no URL-only selection. |
| M6 | New `create_project({projectPath:string,id:string,version:string,name:string,description?:string})`; `open_project({projectPath:string})` | Uses exact UI fields/defaults: version defaults to `0.1.0`, description optional/empty, ID/version/name required; model ID is lowercase alphanumeric with `.`/`-`, version semver. MCP path mode requires an absolute canonical path inside configured `NNM_PROJECT_ROOT`; root, traversal, invalid directory names and collisions are rejected before mutation. Returns `{status:"ok",project:{id,version,name},resourceCount}` only after activation. Cancellation, unsupported API, denial, invalid project and collision preserve startup/previous project and never claim open. | MCP validates the path then forwards it as an opaque request; browser remains responsible for activation/resource scope/autosave and never returns handles. Picker UI remains the graphical fallback. |

`format_view` and `capture_screenshot` share one render-readiness timeout of 10
seconds. `start_training` has a 30-second package preparation/upload handoff
bound; it does not wait for job completion. Progress reads are bounded as
shown above. The existing 8 MiB backend package-bundle limit, 256 package/512
file limits and 1 MiB per package file limit remain in force.

## Capture feasibility gate

The supported in-app Browser was selected and two local tabs were opened:

| Surface | Observation |
| --- | --- |
| In-app Browser tab 1 | Browser tab ID `1`, URL `http://127.0.0.1:5174/`, screenshot succeeded (28,824 bytes) |
| In-app Browser tab 2 | Browser tab ID `2`, URL `http://127.0.0.1:5174/`, screenshot succeeded (28,824 bytes) |
| Real MCP `list_browser_tabs` | `{tabs:[],activeTabId:null}` because both tabs are on the startup chooser and no `DiagramCore`/`BrowserRPCHandler` is mounted |

This is a useful negative two-tab check: the host can capture each browser tab,
but there is no identity relation between host IDs (`1`,`2`) and MCP IDs
(`tab_N`) yet. The current CDP adapter independently chooses a DevTools page by
URL and cannot prove that it is the RPC-selected page. URL matching is not
accepted as isolation evidence.

**T03 is blocked pending one specific integration authority:** the host must
provide a supported capture adapter that accepts the active browser-tab
identity (or an opaque capture binding returned by the same browser session)
and returns PNG bytes/metadata for that exact page. The adapter must be usable
from the MCP process without external CDP, and must reject a stale,
disconnected or non-selected tab. T03 can then perform the two-tab check after
project activation, layout both directions, and verify that each screenshot
comes from the selected page. No host API is invented in T01.

## M6 startup and permission feasibility

`ProjectForm.svelte` is the source of truth for creation: `id`, `version`
(`0.1.0` default), `name`, and optional `description`. It calls
`manifestFromProjectForm`, which trims values, creates schema version 1 with an
empty `customPackages` list, validates the model ID and semver, and creates the
empty project JSON. `ProjectWorkspaceAdapter` uses
`showDirectoryPicker({mode:"readwrite"})`; it distinguishes unsupported,
cancelled, denied, invalid path, collision, missing `model.json` and write
failure. The startup chooser must remain visible until this operation returns
success. Opening reuses `openProjectWorkspace`, reads all declared resources,
and activates the same scope; it is not `import_diagram` or a server-side
filesystem loader.

The explicit MCP path decision adds `projectPath` to both New and Open. The
MCP server requires `NNM_PROJECT_ROOT` and accepts only an absolute canonical
child whose final directory is a lowercase model ID; traversal, root,
outside-root and NUL-containing paths fail before browser RPC. The path is
forwarded only as a request value and never returned as a handle or credential.
The approved path mode now reads/creates files in the confined MCP project
root, transfers model/resources to the browser startup consumer, and receives
only model-save notifications back; activation and ordered workspace state
remain browser-owned.

The MCP request may therefore return `pending` with
`reason:"user_gesture_required"` and a bounded retry hint. A visible browser
action completes the picker; cancellation/denial is an error and a failed
switch leaves the previous project intact. Handles, absolute paths and
permission objects never cross MCP or backend boundaries. T08 owns the shell
bridge and must not mount `DiagramCore` before activation.

## Project-dataset gate and compatibility decisions

The project-workspace initiative is currently `ready`, but its phase-one real
interface task T06 is not passed (all acceptance checks remain unchecked), and
the dataset contract task T07 is `blocked` on that gate. T01 found no landed
project-dataset implementation to import into this initiative. Dataset payloads
therefore remain the current descriptor/`target` shape until the separately
accepted named-batch migration is unblocked; T01 introduces no compatibility
variant or dataset authoring work.

The existing process-authenticated training tool names and behavior are
preserved. New selected-editor operations use the controller above and never
reuse the process token or silently switch ownership. Existing additional
inspection, graph, subflow, selection, import/export/reset, tab, viewport and
low-level training tools remain available even when absent from the UML.

## Legacy-removal audit (2026-08-30)

The current `server.ts` registry discovers 56 tools from the twelve tool
modules (`graph`, `parameters`, `selection`, `canvas`, `validation`,
`conversion`, `inspection`, `lifecycle`, `connection`, `screenshot`,
`remote-training` and `project`). No removal is safe in this parity slice:

- The ten `remote-training` process-authenticated tools (including
  `submit_training_job`, `read_training_progress` and
  `download_training_wheel`) are explicitly retained compatibility contracts;
  they remain routed through `NNM_BACKEND_URL`/`NNM_BACKEND_TOKEN` and must not
  be silently changed to selected-editor ownership.
- The seven selected-editor training tools are the new controller surface, but
  they do not replace the process-authenticated operations above.
- The remaining browser tools, including `import_diagram`, `export_diagram`,
  `reset_diagram`, `create_subflow`, viewport/selection operations and
  inspection/validation operations, are explicitly retained additional
  capabilities. `capture_screenshot` remains the required M5 operation even
  while its selected-tab adapter is blocked.

The audit therefore makes no source or test deletions. The only confirmed
legacy behavior is the rejected `stereotype` creation shape, which is already
removed from the public Zod schema with an `INVALID_ARGUMENT` migration error;
the compatibility and additional-tool contracts above prevent broader cleanup
until an explicit retirement decision is accepted.

## Affected knowledge statements

- The [browser-MCP architecture](../../../knowledge/architecture/browser-mcp.md)
  remains authoritative for one browser `DiagramCore`, thin MCP proxy,
  multi-tab selection and backend ownership. T03 must add the selected-page
  capture binding without changing those boundaries.
- The [accepted UML](../../../knowledge/uml/mcp-use-case-parity.md) remains the
  functional authority; names and payloads above are implementation contracts,
  while its eleven workflows and layout-before-screenshot rule are unchanged.
- The [pairing contract](../../../knowledge/contracts/pairing.md) remains the
  authority for pending/approved/rejected/expired sessions, ownership and
  secret handling.
- The [project workspace decision](../../../knowledge/decisions/project-workspaces-and-stereotype-authoring.md)
  remains authoritative for browser-only handles, user gestures, activation,
  collision behavior and ordered persistence.
