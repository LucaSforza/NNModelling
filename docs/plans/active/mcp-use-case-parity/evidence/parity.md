---
kind: evidence
task: T07
status: blocked
updated: 2026-08-30
---

# T07 parity verification evidence

This record contains observations from the public MCP stdio transport and the
Codex in-app Browser on 2026-08-30. Unit tests and proxy mocks are reported as
automated checks only; they are not live workflow proof.

## Live setup and transport

Commands run from the repository root:

```text
.agents/skills/nnmodelling-mcp/scripts/nnm-stack.sh frontend
.agents/skills/nnmodelling-mcp/scripts/nnm-stack.sh mcp
```

The frontend was reachable at `http://127.0.0.1:5174/`. The MCP server built
and started on stdio, opened its browser WebSocket listener on `ws://localhost:9339`,
and registered 54 tools. An actual JSON-RPC `initialize` followed by
`tools/list` returned the catalog below (the complete payload was retained in
the transport output; no credentials or tokens were recorded).

The in-app Browser opened `http://127.0.0.1:5174/` as tab `1`. Its visible
state was the startup chooser (`Apri un progetto`), not an editor. Consequently
the public `list_browser_tabs` call returned `{tabs:[],activeTabId:null}` and
browser calls returned `INTERNAL_ERROR: No browser connected`. This is the
expected startup/project-activation boundary recorded by T01/T08, not a live
diagram failure.

Representative public calls and results:

| JSON-RPC operation | Observed result |
| --- | --- |
| `ping` | `isError:true`, `No browser connected` |
| `list_browser_tabs` | success, `{tabs:[],activeTabId:null}` |
| `get_graph`, `get_package_diagnostics`, `get_training_connection`, `get_training_config` | `isError:true`, `No browser connected` |
| `get_node({})` | `INVALID_ARGUMENT`, `nodeId: Required` before dispatch |
| `read_training_progress({jobId:"x",waitMs:999999})` | `INVALID_ARGUMENT`, wait bound `30000` enforced before dispatch |
| `capture_screenshot({outputPath:"/tmp/t07.png"})` | explicit DevTools-unavailable error; no image claimed |
| `format_view({direction:"vertical"})` | JSON-RPC `Unknown tool`; no such public operation is registered |
| `list_training_datasets`, `list_training_compute_units`, `read_training_progress` | backend `fetch failed`; no backend was running or authorized |

The `create_node` invalid package call reached the browser boundary and
returned `No browser connected`; it therefore proves neither package
activation nor a mutation. The live `tools/list` schema shows package-only
creation, `output` kind, typed `parameters`, and `wheelAdapters`. It also shows
typed `set_parameter`/`update_parameters` values and bounded progress inputs.

## UML workflow map

Every accepted UML oval is mapped below. “Blocked” means the required public
workflow could not be completed in the available environment; it is not a
claim of support.

| ID | Public-interface observation | Result / blocker |
| --- | --- | --- |
| M1 Add node | `create_node` is present in `tools/list` with a package descriptor, typed parameters, defaults/option fields, and `wheelAdapters`; a real call was attempted. | Blocked at startup because no project/DiagramCore was mounted. No node mutation is claimed. |
| M2 Connect nodes | `connect_nodes` is present with source/target handles. | Blocked at startup; invalid-handle/ordering behavior requires an active disposable graph. |
| M3 Edit node parameters | `set_parameter` and `update_parameters` advertise `unknown` typed values; `get_node` missing input was rejected at the public boundary. | Blocked at startup; typed round-trip and autosave/reopen require an active project. |
| M4 Format view | No `format_view` operation appears in the actual 54-tool catalog. | Incomplete implementation gate; `fit_view`, `center_view`, and manual movement are not equivalent to Disponi. |
| M5 Screenshot | `capture_screenshot` is registered, but its public call failed because the documented Chromium DevTools endpoint was unavailable; it does not bind to MCP tab identity or perform layout. | Blocked by missing supported selected-tab capture adapter and unavailable DevTools; no screenshot proof. |
| M6 Open project | Browser UI visibly exposes New/Open. New form showed exactly `id`, `version` (default `0.1.0`), `name`, optional `description`; invalid `Bad ID` produced `model manifest id is invalid`. A valid disposable submission stayed at `Creazione…` while the directory picker/permission request remained unresolved. | Blocked by startup directory-picker/user-gesture host integration. No project was opened or written. |
| T1 Connect backend | `connect_training_backend`, `get_training_connection`, `renew_training_connection`, and `disconnect_training_backend` are registered. | Blocked because startup had no active editor controller and no authorized backend session; no pairing approval or token was manufactured. |
| T2 Edit training parameters | `get_training_config` and `update_training_config` are registered with a typed patch boundary. | Blocked because no active controller/project was mounted; no field round-trip is claimed. |
| T3 Launch training | `start_training` is registered and has no raw job argument, matching active-snapshot design. | Blocked by missing active project, backend authorization, and explicit live-job authorization. No job was submitted. |
| T4 Monitor training | `read_training_progress` is registered with bounded cursors/wait/bytes; an over-limit `waitMs` was rejected publicly. | Blocked by absence of an authorized fixture job/backend. No progress stream is claimed. |
| T5 Download wheel | `download_training_wheel` is registered with owned-job/destination inputs. | Blocked by absence of an authorized completed fixture job and wheel. No artifact, digest, install, or prediction is claimed. |

The M4→M5 UML extension ordering is therefore not satisfied: no layout
operation exists and no selected-tab browser image was captured. The required
T5 follow-up (install the downloaded wheel in a clean temporary uv consumer,
import its `Model`, and call the fixture's public prediction API without
repository `PYTHONPATH`) was not run because no wheel exists.

### Follow-up dependency

The parent workflow subsequently reopened T08 with a new decision that MCP
create/open will accept an explicit `projectPath` and operate autonomously.
That implementation was not present in this verification run. T07 remains
blocked and must be rerun after T08 lands; the current catalog and startup
chooser observations are historical evidence, not acceptance of the new M6
contract.

## Automated checks

These checks passed on the final worktree state; they supplement but do not
replace the blocked live gates:

```text
pnpm --dir mcp-server test   # 5 files, 51 tests passed
pnpm --dir front-end check   # 0 errors, 35 existing warnings
pnpm --dir front-end test    # 37 files, 208 tests passed
```

No source implementation was changed for this verification slice. The only
remaining acceptance blockers are host-provided startup project activation,
selected-tab capture binding/DevTools availability, and an explicitly
authorized backend session plus fixture-owned completed job/wheel.

## Post-T08 rerun (2026-08-30)

This section is appended after T08 commit `17b28fb`; the initial run above is
historical and is not overwritten. The MCP server was restarted with
`NNM_PROJECT_ROOT=/tmp/nnm-t07-project-root` and the real stdio transport
returned **56 tools**. The catalog delta is the two public project tools:

```text
create_project({projectPath:string, id:string, version?:string="0.1.0", name:string, description?:string})
open_project({projectPath:string})
```

`projectPath` is advertised as required and absolute/canonical; `id`,
`version`, and `name` mirror the creation form. The complete `tools/list`
payload also retained the T02–T06 operations and typed/bounded schemas.

The confined root was created at `/tmp/nnm-t07-project-root`. Public calls over
the actual transport produced these observations:

| Call | Result |
| --- | --- |
| `create_project({projectPath:"/tmp/nnm-t07-project-root/demo",id:"demo",name:"T07 demo"})` | Candidate files were created, then the browser bridge returned `INTERNAL_ERROR: No browser connected`; rollback was confirmed because `demo` was absent afterward. |
| `open_project({projectPath:"/tmp/nnm-t07-project-root/missing"})` | `PROJECT_NOT_FOUND`; no mutation. |
| `create_project({projectPath:"/tmp/outside/demo",...})` | `PROJECT_PATH_OUTSIDE_ROOT`; no mutation. |
| `get_graph({})` | `INTERNAL_ERROR: No browser connected`; truthful pre-editor behavior preserved. |
| `list_browser_tabs({})` | success `{tabs:[],activeTabId:null}`. |

The in-app Browser runtime was unavailable during this rerun (`browsers.list()`
returned `[]`), so the startup bridge could not be observed through a real
browser tab. Therefore activation, visible project name, DiagramCore binding,
M1–M3 mutations, autosave notification and reopen remain unverified. The
transport-level create rollback and path confinement are verified, but are not
substitutes for the required browser activation evidence.

Training remained intentionally unsubmitted. No authorized backend session,
examples-fixture job, or completed wheel was available. Consequently T1–T5,
progress streaming, digest verification, clean `uv` installation and public
`Model` prediction remain explicit authorization/environment gates. M4/M5 also
remain blocked: the catalog still has no `format_view`, and no supported
selected-MCP-tab screenshot binding or DevTools endpoint was available.
