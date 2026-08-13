---
name: nnmodelling-mcp
description: Operate NNModelling through its live browser DiagramCore and browser-backed MCP server. Use when Codex or OpenCode must open or diagnose the editor, frontend, Chromium DevTools, WebSocket bridge, or MCP stdio server; inspect or edit a neural-network diagram; query tensor types; capture screenshots or hover tooltips; convert a diagram; train or run inference; or diagnose leaked ports and disconnected browser sessions. Route Codex desktop to its in-app Browser when appropriate while preserving external Chromium/CDP as the OpenCode, CLI, and unsupported-host fallback.
---

# NNModelling Browser and MCP

Treat the browser's `DiagramCore` as the only diagram state. Treat the MCP
server as a thin semantic proxy, not as a second graph. It cannot manipulate a
diagram until a frontend tab connects to `ws://localhost:9339`.

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

## Select the browser surface

Honor an explicit browser choice. Do not replace an explicitly requested
in-app Browser with Chromium, or an explicitly requested Chrome/Chromium
session with the in-app Browser.

When the user does not choose a surface, select in this order:

1. If the host exposes a dedicated in-app Browser capability, prefer it for a
   shared visual workflow. In Codex desktop, load and follow the available
   `control-in-app-browser` skill before browser actions. Let that skill perform
   browser discovery and control; do not reproduce its private setup here.
2. If the user requests direct Chrome/Chromium control, or the in-app Browser
   is unavailable, load `chrome-direct` when available and use the external
   Chromium branch below.
3. In OpenCode or another host without the Codex in-app Browser, use the
   external Chromium branch. Do not attempt to invoke Codex-only browser APIs.

Do not infer a capability from the model or provider name. Inspect the skills
and tools actually exposed by the host.

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

3. Open the frontend with the selected visual surface:

   - **In-app Browser:** open `http://127.0.0.1:5174` through the host's Browser
     capability. Do not run the `browser` subcommand merely to obtain a second
     copy of the page.
   - **External Chromium/OpenCode fallback:** keep this in a separate
     persistent terminal:

     ```bash
     .agents/skills/nnmodelling-mcp/scripts/nnm-stack.sh browser
     ```

4. Wait for `Browser tab connected`. With multiple connected frontend tabs,
   call `list_browser_tabs` and `select_browser_tab`; never guess which tab is
   active.

5. Run the status command again. Chromium DevTools on port 9223 may correctly
   remain unavailable for an in-app Browser session. The required conditions
   are a reachable frontend, one MCP server on 9339, and a selected frontend
   tab.

Defaults are frontend `http://127.0.0.1:5174`, external Chromium DevTools
`9223`, and the browser WebSocket bridge `9339`. Override the first two with
`NNM_FRONTEND_URL` and `NNM_CDP_PORT`.

If Chromium is not installed as Flatpak, set `NNM_BROWSER_COMMAND` to a working
executable. Do not use this machine's `~/.local/bin/google-chrome` wrapper
without checking it: it may depend on an unavailable `cobalt` binary.
Launching the Flatpak GUI normally requires elevated execution approval; ask
for it through the command tool instead of falling back to an unrelated
browser.

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

## Inspect types and visual state

`get_type_info` returns JSON-safe input/output shapes, dtype, errors, warnings,
and suggestions. A Loss is conceptually a layer with rank-1 output `[B]`, even
though the current Python backend treats it as a terminal objective.

Choose the screenshot path by surface:

- **In-app Browser:** use the Browser capability for screenshots, hover,
  rendered-state inspection, and visual verification. Use its Developer Mode
  only when DOM, CSS, console, network, or performance inspection is needed and
  the required approval is granted. Do not expect this tab to appear on the
  external CDP port 9223.
- **External Chromium:** use MCP `capture_screenshot` with `pageUrl` when
  several DevTools pages exist, `hoverNodeId` for the tensor tooltip, and an
  explicit `/tmp/*.png` `outputPath` for later inspection.

Use `reloadPage: true` only to discard broken HMR state. Reloading resets the
in-memory diagram. After any reload, wait for reconnection and recreate or
import the diagram before capturing evidence.

## Convert and train

1. Build a type-correct graph with an explicit `Flatten` before a Linear layer
   when an image dataset supplies `[B,C,H,W]` tensors.
2. For a small MNIST classifier, prefer:

   ```text
   Input → Flatten → Linear(784,64) → ReLU → Linear(64,10)
         → CrossEntropyLoss
   ```

   Do not add Softmax before CrossEntropyLoss; it expects logits.
3. Call `execute_conversion` with a fresh output directory, MNIST dataset,
   `numClasses: 10`, and the intended epoch count.
4. Inspect the generated config or conversion result. Require
   `taskType: classification` and confirm the expected layers.
5. Call `execute_training` with `device: cpu` and a small `maxEpochs` value.
   The server translates these to Hydra overrides and writes each run to an
   isolated `/tmp/nnmodelling-training-*` directory.
6. Verify `success: true` and that `checkpointPath` exists. Preserve the path
   if inference will follow.

Avoid transformer and autoencoder training unless the user explicitly requests
it. For smoke testing, train only two or three small networks at most.

## Diagnose failures

- `ECONNREFUSED` on 9339: the MCP server is absent or still starting.
- MCP reports no selected tab: the frontend is absent, reloading, connected to
  another server instance, or the chosen browser cannot reach the local bridge.
- An in-app Browser opens the page but never connects: inspect console and
  network state through that Browser. If the user did not explicitly require
  it, use external Chromium as the compatibility fallback; otherwise report
  the failure without silently switching surfaces.
- External screenshot cannot find a page: start Chromium with
  `--remote-debugging-port` and pass the exact `pageUrl`.
- Port 9223 is unavailable during an in-app Browser workflow: this is expected;
  use the in-app Browser's own screenshot and inspection capabilities.
- Hydra rejects `--max-epochs` or `--device`: the server build is stale;
  rebuild and restart it. Current code must emit `trainer.*` overrides.
- Linear matrix mismatch on MNIST: add `Flatten`; static Input metadata alone
  does not reshape runtime tensors.
- Port leak: run the status script and inspect the owning PID. Stop only the
  stale process, with user approval when ownership is uncertain. Never start a
  second MCP server on 9339.

After changing MCP TypeScript, run `pnpm --dir mcp-server test`, then restart
the stdio server so the live process uses the new `dist/` build.
