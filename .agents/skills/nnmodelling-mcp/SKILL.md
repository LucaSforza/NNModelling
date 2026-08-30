---
name: nnmodelling-mcp
description: Operate NNModelling through its live browser DiagramCore and browser-backed MCP server. Use when Codex must open or diagnose the editor, frontend, WebSocket bridge, or MCP stdio server; inspect or edit a neural-network diagram; query tensor types; capture screenshots or hover tooltips; convert a diagram; train or run inference; or diagnose leaked ports and disconnected browser sessions. Always use the Codex in-app Browser; never fall back to external Chromium, Chrome, or CDP.
---

# NNModelling Browser and MCP

Treat the browser's `DiagramCore` as the only diagram state. Treat the MCP
server as a thin semantic proxy, not as a second graph. It cannot manipulate a
diagram until a frontend tab connects to `ws://localhost:9339`.

## Current MCP architecture

The live server discovers tool exports from `mcp-server/src/tools/` and exposes
them over MCP stdio. Tool handlers either forward a browser RPC request to the
selected tab or call the authenticated FastAPI compatibility client; the MCP
process never owns a graph, package catalog, scheduler or training artifact
store. The browser bridge is:

```text
MCP stdio -> MCP tool adapter -> BrowserRPCClient
                              -> BrowserRPCHandler -> DiagramCore/TrainingController
```

The first connected browser tab is selected automatically. With multiple tabs,
always call `list_browser_tabs` and then `select_browser_tab` explicitly. Losing
the selected tab clears the selection; a fresh in-app Browser tab must connect
before graph or editor-scoped training calls can work.

Use two complementary channels:

- Use NNModelling MCP tools for graph state, tensor types, deterministic edits,
  conversion, training, and inference.
- Use the selected browser surface for visible UI state, clicks, typing, hover,
  screenshots, annotations, DOM/CSS inspection, console output, and network
  diagnostics.

Prefer MCP for graph operations even when browser clicking is available. Use
UI gestures when reproducing UI behavior, exercising a control that MCP does
not expose, or satisfying an explicit request to interact manually. Verify any
UI-driven graph mutation through MCP afterward.

## Mandatory browser surface

Every live NNModelling workflow in this skill MUST use the Codex desktop
in-app Browser. Before any browser action, load and follow the available
`control-in-app-browser` skill and select the Codex in-app Browser through its
browser client.

Do not use external Chromium, Chrome, `chrome-direct`, CDP, or the
`nnm-stack.sh browser` fallback. If the Codex in-app Browser is unavailable,
cannot connect, or fails during the workflow, stop and report the blocker;
never switch browser surfaces silently or automatically.

## Start the shared stack

Run commands from the repository root. Check the current processes first and
reuse healthy ones:

```bash
.agents/skills/nnmodelling-mcp/scripts/nnm-stack.sh status
```

Start only missing components in persistent terminals:

1. Start the frontend when its URL is unavailable:

   ```bash
   .agents/skills/nnmodelling-mcp/scripts/nnm-stack.sh frontend
   ```

2. Start the MCP stdio server through the client's configured MCP transport.
   For direct debugging, or when the client exposes no transport, keep this in
   a persistent terminal:

   ```bash
   .agents/skills/nnmodelling-mcp/scripts/nnm-stack.sh mcp
   ```

   Reuse a server already listening on port 9339. Never start a second one.

3. Open `http://127.0.0.1:5174` through the Codex in-app Browser. Do not run
   the `browser` subcommand or open a second external copy of the page.

4. Wait for `Browser tab connected`. With multiple connected frontend tabs,
   call `list_browser_tabs` and `select_browser_tab`; never guess which tab is
   active.

5. Run the status command again. The required conditions are a reachable
   frontend, one MCP server on 9339, and a selected frontend tab in the Codex
   in-app Browser.

The default frontend is `http://127.0.0.1:5174`; override it with
`NNM_FRONTEND_URL` when needed. Port 9223 and `NNM_CDP_PORT` are not part of
this workflow.

## Connect over raw stdio when MCP tools are absent

Prefer directly exposed NNModelling MCP tools. If the host has not exposed
them, keep `pnpm --dir mcp-server start` in a PTY and send one JSON object per
line. Initialize before tool calls:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent-client","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
```

Call a tool with:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_graph","arguments":{}}}
```

Wait for `Browser tab connected` before graph calls. This fallback is
host-neutral and works for Codex and OpenCode.

The current registry includes graph, parameter, selection, canvas, validation,
serialization, project, browser-tab, package-diagnostic and training tools.
Do not infer a tool from an old plan: call `tools/list` when the exposed
registry is unknown.

## Project lifecycle and package identity

The project page may initially have no active diagram. Use MCP lifecycle tools:

- `create_project({projectPath, id, version, name, description})` creates a
  confined package-format project and activates it in the browser.
- `open_project({projectPath})` loads an existing project under the configured
  `NNM_PROJECT_ROOT` and activates it in the selected browser tab.
- `import_diagram` imports JSON into the already active editor; it is not a
  replacement for project activation.

Use the actual package-format path under `examples/diagrams/package/models/`
for repository examples. The frontend package catalog is authoritative. Every
`create_node` package object must contain the exact catalog `id`, `version`,
display `name`, and `kind`; pass typed JSON `parameters` and use
`wheelAdapters` only when the package manifest requires them. Do not send the
legacy stereotype-only shape or edit `model.json` directly to build the live
graph. After the MCP mutations, the browser owns persistence and sends the
project-save notification back to the server.

## Manipulate and inspect diagrams

Use MCP tools instead of editing browser state or diagram JSON directly:

- Inspect: `get_graph`, `get_node`, `get_type_info`, `get_edges`.
- Mutate: `create_node`, `connect_nodes`, `disconnect_nodes`,
  `update_parameters`, `move_nodes`, `delete_nodes`.
- View: `fit_view`, `center_view`, `clear_selection`.
- Validate before conversion: call `get_type_info` with `refresh: true` and
  require no hard errors.

Preserve handle order for non-commutative joins. Use `in-0`, `in-1`, and later
handles explicitly; never rely on traversal order.

After structural edits, arrange nodes vertically or horizontally with
`move_nodes`, clear selection, and call `fit_view`. Then verify the rendered
diagram through the selected browser surface.

For joins, use explicit ordered target handles (`in-0`, `in-1`, ...). For a
residual feed-forward block, the skip and transformed branch may be joined only
when their tensor shapes and dtypes match; keep the main branch on `in-0` and
the skip branch on `in-1` so non-commutative `Add` semantics are unambiguous.

## Inspect types and visual state

`get_type_info` returns JSON-safe input/output shapes, dtype, errors, warnings,
and suggestions. A Loss is conceptually a layer with rank-1 output `[B]`, even
though the current Python backend treats it as a terminal objective.

Use the Codex in-app Browser for screenshots, hover, rendered-state inspection,
and visual verification. Use `tab.screenshot()` or the browser's visible DOM
surface for this. The MCP `capture_screenshot` helper is a separate
compatibility path and currently targets Chromium/CDP page discovery; it is
not a substitute for the selected in-app Browser and does not perform layout
or wait for editor rendering.

Use `reloadPage: true` only to discard broken HMR state. Reloading resets the
in-memory diagram. After any reload, wait for reconnection and recreate or
import the diagram before capturing evidence.

## Validate, train and consume a package

1. Build a type-correct graph with an explicit `Flatten` before a Linear layer
   when an image dataset supplies `[B,C,H,W]` tensors. For classification,
   finish with logits and `CrossEntropyLoss`; never add Softmax before that
   loss.
2. Call `get_type_info({refresh:true})`, `validate_parameters` and
   `validate_graph`. Require no hard type errors and exactly one top-level
   `Input` before training.
3. Use the selected-editor training route, which shares the browser's
   `TrainingController` with the Training sidebar:

   ```text
   connect_training_backend
   get_training_connection / renew_training_connection
   get_training_config
   update_training_config({patch:{...}})
   start_training
   read_editor_training_progress
   download_editor_training_wheel
   ```

   `start_training` snapshots the active browser diagram and submits the
   package-native job through the paired browser session. Configure typed
   dataset parameters (for example `batch_size: 32`, not `"32"`) and set the
   intended `maxEpochs` explicitly. The backend launches one short-lived
   worker container per job.
4. Monitor with `read_editor_training_progress`. Carry forward both
   `nextEventCursor` and stdout/stderr `nextOffset` values; use bounded
   `waitMs <= 30000` and `maxBytes <= 262144`. A successful result must show
   `job.status == "succeeded"`, the expected epoch count, no diagnostics, and
   a package manifest.
5. Download selected-editor weights with
   `download_editor_training_wheel`. The browser verifies the manifest/header/
   body digest; MCP verifies byte count and SHA-256 again and writes a private,
   non-overwriting artifact. Never expose bearer tokens or wheel bytes in MCP
   results.
6. Keep `submit_training_job`, `read_training_progress`,
   `get_training_job*`, `cancel_training_job` and `download_training_wheel` as
   compatibility tools only. They use the process-configured
   `NNM_BACKEND_URL`/`NNM_BACKEND_TOKEN` and are not interchangeable with the
   selected editor's paired identity.
7. Validate a downloaded wheel against the model-package contract: import
   `nnm_<suffix>`, instantiate public `Model`, use `predict` and declared
   adapters such as `encode`/`forward`, and exercise the real consumer script.

## Diagnose failures

- `ECONNREFUSED` on 9339: the MCP server is absent or still starting.
- MCP reports no selected tab: the frontend is absent, reloading, connected to
  another server instance, or the chosen browser cannot reach the local bridge.
  Call `list_browser_tabs`; if it is empty, obtain a fresh in-app Browser tab,
  navigate to the frontend URL, and wait for `Browser tab connected`.
- An in-app Browser opens the page but never connects: inspect console and
  network state through that Browser, then report the failure if it persists.
  Do not switch to another browser surface.
- Training fails before a worker starts: inspect `get_training_connection`,
  `get_training_config`, the selected-editor progress result and backend health;
  do not fall back to host Python or a second scheduler.
- Linear matrix mismatch on MNIST: add `Flatten`; static Input metadata alone
  does not reshape runtime tensors.
- Port leak: run the status script and inspect the owning PID. Stop only the
  stale process, with user approval when ownership is uncertain. Never start a
  second MCP server on 9339.

After changing MCP TypeScript, run `pnpm --dir mcp-server test`, then restart
the stdio server so the live process uses the new `dist/` build. After changing
the frontend RPC handler, rebuild/restart the frontend and reconnect the Browser
tab before testing the new RPC method.
