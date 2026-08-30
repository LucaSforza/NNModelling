---
kind: knowledge
status: current
updated: 2026-08-30
---

# Browser-backed MCP architecture

The MCP server is a thin request/response proxy. It never owns a `DiagramCore`
or a copy of nodes and edges. Required workflow parity is defined separately by
the accepted [MCP use-case constraint](../uml/mcp-use-case-parity.md).
The coverage below describes implementation, not fulfillment of that constraint.

```text
MCP client
  -> stdio server and tool adapters
  -> BrowserRPCClient (WebSocket server, multi-tab routing)
  -> BrowserRPCHandler (selected browser tab)
  -> DiagramCore
```

## Ownership

- `front-end/src/core/DiagramCore.ts` owns graph state and mutations.
- `front-end/src/sync/BrowserRPCHandler.ts` validates and dispatches browser RPC
  methods against the live diagram.
- `mcp-server/src/browser-client.ts` accepts browser connections, assigns
  sequential tab IDs, selects an active tab and correlates pending requests.
- `mcp-server/src/tools/` exposes narrow MCP adapters.
- `mcp-server/src/tools/connection.ts` manages the proxy's tab selection locally.
- `mcp-server/src/tools/remote-training.ts` bypasses browser RPC and calls
  FastAPI through `RemoteTrainingClient`; it does not access sidebar state.
- `mcp-server/src/tools/screenshot.ts` bypasses browser RPC and captures a
  Chromium page through CDP. This is not the editor's PNG export operation.
- Package compilation and training execution belong to the authenticated
  backend API, not a subprocess or second scheduler inside MCP.

## RPC contract

```json
{ "id": "1", "method": "get_graph", "params": {} }
{ "id": "1", "result": { "nodes": [], "edges": [] } }
{ "id": "1", "error": { "message": "..." } }
```

Browser RPC requests time out at the server boundary. The separate HTTP training
client has no explicit request timeout. Browser-side failures are returned as
plain error messages. MCP results are serialized as JSON in text content;
screenshot results contain local file metadata, not MCP image content.

[`server.ts`](../../../mcp-server/src/server.ts) discovers `{schema, handler}`
exports, publishes JSON input schemas, and dispatches requests directly to
handlers. It does not call the tools' Zod parsers before dispatch. Input schema
advertisement therefore must not be confused with server-side validation.
Descriptions are generic tool names; the registry does not encode use-case
groups, `include`/`extend` relations, prerequisite workflows or agent roles.

## Multi-tab behavior

- Each browser connection receives `tab_<n>`.
- The first connected tab is selected automatically.
- Additional tabs do not replace the active tab.
- `list_browser_tabs` and `select_browser_tab` expose explicit selection.
- Losing the active tab clears selection; graph tools fail until another tab is
  selected.
- Screenshot targeting is independent: `pageUrl`/`NNM_FRONTEND_URL` and CDP page
  discovery select the page, not `select_browser_tab`.
- HTTP training uses the process-configured backend URL and bearer token, not
  the selected browser tab's paired session. Different connection identities
  do not share job ownership automatically.

## Compatibility constraints

- Standard handles are `in` and `out`; join targets use `in-0`, `in-1`, etc.
- Browser mutations must trigger Svelte reactivity and one logical graph-change
  notification.
- The browser package catalog is authoritative; the server keeps no local
  stereotype projection or fallback catalog.

## Coverage of the accepted use cases

| Use case | Actual behavior and gap |
|---|---|
| Connect to backend | HTTP calls use `NNM_BACKEND_URL` and `NNM_BACKEND_TOKEN`. MCP exposes no pairing, renewal, session inspection or backend-selection workflow equivalent to the sidebar. |
| Edit training parameters | `submit_training_job` accepts a complete opaque `job` object. The caller can supply backend fields, but there is no tool to inspect or update the sidebar's training configuration. |
| Launch training | MCP forwards `POST /jobs`. It does not build or upload the active diagram's package bundle, unlike `TrainingSidebar.buildRequest`. A valid already-uploaded, owned bundle reference must come from elsewhere. |
| Monitor training | Job listing, status, full logs and events are exposed. Events are buffered with `response.text()` until the SSE response closes, not delivered incrementally. The browser's incremental log-tail endpoint is not exposed by MCP. |
| Download wheel | The browser and backend implement authenticated wheel retrieval and integrity checks. Neither the MCP registry nor `RemoteTrainingClient` exposes the download. |
| Add node | Browser RPC creates a real package node in the shared diagram. It does not use the complete sidebar creation seam: it omits `wheelAdapters` and supplies `{}` when parameters are omitted, whereas the sidebar materializes defaults. The advertised package-kind enum also omits `output`, and the advertised legacy `stereotype` alternative is rejected by browser RPC. |
| Connect nodes | `connect_nodes` delegates to the shared `DiagramCore.addEdge`, preserving its graph/handle checks. |
| Edit node parameters | RPC updates the shared node, but `set_parameter` and `update_parameters` advertise string-only values. The browser handler stores supplied values without the sidebar's number/boolean/list/reference conversions. Typed RPC payloads can work outside the advertised schema; stringifying them is not equivalent. |
| Format view | `FlowCanvas` calls `diagram.autoLayout` for horizontal/vertical **Disponi**. No MCP tool or browser RPC case exposes it. `fit_view`, `center_view` and `move_nodes` are not equivalent. |
| Screenshot | CDP capture supports optional reload and output-handle hover. It neither performs layout nor waits for the editor's layout/render completion, so it does not enforce the required layout-before-capture workflow. |

### Implementation evidence

- [Node creation and parameter RPC](../../../front-end/src/sync/BrowserRPCHandler.ts):
  `handleCreateNode`, `handleSetParameter`, `handleUpdateParameters`.
- [Sidebar behavior](../../../front-end/src/components/Sidebar.svelte):
  `onPackageChange`, `handleCreate`, `updatePackageParameter`, `updateReference`;
  [parameter defaults](../../../front-end/src/type-system/editor/package-ui.ts):
  `initialPackageParameters`.
- [Advertised graph schema](../../../mcp-server/src/tools/graph.ts) and
  [parameter schemas](../../../mcp-server/src/tools/parameters.ts).
- [Layout UI](../../../front-end/src/FlowCanvas.svelte): `handleAutoLayout`;
  [screenshot implementation](../../../mcp-server/src/chromium-screenshot.ts):
  `selectTarget`, `captureChromiumScreenshot`.
- [Training UI](../../../front-end/src/components/TrainingSidebar.svelte):
  `connect`, `buildRequest`, `submit`, `downloadModelPackage`;
  [browser HTTP client](../../../front-end/src/training/api.ts):
  `uploadPackageBundle`, `downloadModelPackage`, `subscribeTrainingEvents`.
- [MCP training tools](../../../mcp-server/src/tools/remote-training.ts),
  [HTTP client](../../../mcp-server/src/remote-training.ts), and
  [backend routes](../../../converted/src/backend/app.py): `/package-bundles`,
  `/jobs`, `/jobs/{job_id}/package`, `/jobs/{job_id}/events`.

## Additional exposed capabilities and implementation caveats

Beyond the diagram's explicit use cases, MCP exposes graph/node/edge/subflow
inspection, tensor types, statistics, catalog and package diagnostics;
deletion, duplication, manual movement, disconnection and subflow creation;
selection operations; parameter query/reset; diagram JSON import/export/reset;
tab discovery/selection and ping; viewport fitting/centering; dataset and compute
discovery; and training cancellation. These capabilities are not automatically
superfluous and are not candidates for removal merely because they are absent
from the use-case diagram.

Some advertised operations are weaker than their names suggest:

- `validate_connections`, `validate_parameters` and `validate_subflows` return
  constant successful results in `BrowserRPCHandler`, without validation.
- `validate_graph` checks a subset of topology rules; it does not aggregate
  the package type engine's diagnostics. Its exactly-one-Input rule must be
  reassessed when the accepted named-batch/multiple-input transition is
  implemented, not silently treated as that future contract.
- `get_canvas_state` returns the constant `{zoom: 1, x: 0, y: 0}`.
- `fit_view` and `center_view` return success even without a viewport controller;
  with one present they invoke it without awaiting the view operation.

## Verification scope

Use `pnpm --dir mcp-server test` and the frontend `BrowserRPCPackageOnly` tests
for the existing adapter/protocol checks. Several tests call handlers with
mocked browser/backend responses, including a legacy stereotype-only creation
fixture that the real browser rejects. Passing these suites is not proof of
sidebar parity, live screenshot correctness, package upload or successful
training. Final parity acceptance must use the end-to-end workflow defined in
the decision, without modifying an unrelated user's live graph or submitting
training jobs merely to inspect this architecture.

Run browser-backed work through the repository's `chrome-direct` or
`nnmodelling-mcp` skill as directed by the root `AGENTS.md`.
