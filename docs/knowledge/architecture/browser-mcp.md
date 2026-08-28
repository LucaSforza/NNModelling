---
kind: knowledge
status: current
updated: 2026-08-12
---

# Browser-backed MCP architecture

The MCP server is a thin request/response proxy. It never owns a `DiagramCore`
or a copy of nodes and edges.

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
- `mcp-server/src/tools/` contains browser proxies only; package compilation
  and training are performed by the authenticated backend API.

## RPC contract

```json
{ "id": "1", "method": "get_graph", "params": {} }
{ "id": "1", "result": { "nodes": [], "edges": [] } }
{ "id": "1", "error": { "message": "..." } }
```

Requests time out at the server boundary. Browser-side failures are returned as
plain error messages. The MCP server does not create Python conversion or
training subprocesses.

## Multi-tab behavior

- Each browser connection receives `tab_<n>`.
- The first connected tab is selected automatically.
- Additional tabs do not replace the active tab.
- `list_browser_tabs` and `select_browser_tab` expose explicit selection.
- Losing the active tab clears selection; graph tools fail until another tab is
  selected.

## Compatibility constraints

- Standard handles are `in` and `out`; join targets use `in-0`, `in-1`, etc.
- Browser mutations must trigger Svelte reactivity and one logical graph-change
  notification.
- The server keeps an ESM-safe projection of stereotype JSON instead of
  importing the Vite loader.

Run browser-backed work through the repository's `chrome-direct` or
`nnmodelling-mcp` skill as directed by the root `AGENTS.md`.
