# MCP server agent guidance

Applies to `mcp-server/`. Inherit repository-wide rules from `../AGENTS.md`.

## Commands

```bash
pnpm --dir mcp-server build
pnpm --dir mcp-server test
pnpm --dir mcp-server start
npx tsx mcp-server/src/index.ts
```

Use the `nnmodelling-mcp` skill for live NNModelling browser operation or
connection diagnosis. Reuse its host-aware browser routing, stack helper and
startup order.

## Architecture contract

The MCP server is a thin proxy. Live diagram state exists only in the browser's
`DiagramCore`:

```text
MCP stdio client -> server tools -> browser-client WebSocket RPC
                                  -> BrowserRPCHandler -> DiagramCore
```

- Never add a server-side DiagramCore, mirrored graph, delta event bus,
  transaction manager or history manager.
- `src/browser-client.ts` owns WebSocket RPC and multi-tab selection.
- `src/tools/` contains narrow tool adapters for graph, parameters, selection,
  canvas, validation, conversion, inspection, connection and lifecycle actions.
- The first browser tab is auto-selected. Preserve explicit `list_browser_tabs`
  and `select_browser_tab` behavior for multiple tabs.
- `src/server.ts` keeps an ESM-safe local projection of stereotype JSON because
  the MCP server must not import the Vite frontend loader.
- `src/pipeline.ts` is the Python subprocess boundary. Keep pipeline failures in
  the small dedicated error hierarchy rather than rebuilding domain errors.
- Conversion tools query the browser for current NNTree JSON before invoking
  Python; they must not rely on stale local state.
- Optional HTTP training proxy tools must reuse FastAPI job state rather than
  create a second scheduler or persistence layer.

## Verification

Run the focused Vitest suite and `pnpm --dir mcp-server test`. Changes to RPC
method names or payloads also require corresponding frontend
`BrowserRPCHandler` tests. Changes to conversion subprocess behavior require the
relevant integration tier in `front-end/`.

Current ownership and protocol constraints are documented in
`../docs/knowledge/architecture/browser-mcp.md`. Removed pre-simplification
architecture is preserved under `../docs/archive/superseded/` and is not
current design.
