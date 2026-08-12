# MCP Server Simplification Plan

> **Archive note (2026-08-12):** the status below records the document as
> originally written. Its thin-proxy target architecture is implemented; use
> [`docs/knowledge/architecture/browser-mcp.md`](../../../knowledge/architecture/browser-mcp.md)
> for the current contract.

## Original status: DRAFT — Awaiting Approval

---

## 1. Problem Summary

The MCP server maintains a **full server-side copy of the diagram state** (`DiagramCore`), then uses a complex delta protocol to keep the browser's `$state.raw` arrays in sync. This causes ~2000 lines of duplicated effort across the EventBus, delta protocol, TransactionManager, HistoryManager, 14 resources, and the `push_state`/`importFromJson` sync dance.

**Root cause**: the server owns a `DiagramCore` instance. **Fix**: the browser is the single source of truth; the server is a thin proxy.

## 2. Target Architecture

```
Model (LLM)
  │ stdio (MCP protocol)
  ▼
MCP Server (~900 lines, from ~4000)
  │  - Zod schema input validation
  │  - WebSocket RPC client (multi-tab, request/response)
  │  - Multi-tab connection manager (list_browser_tabs, select_browser_tab)
  │  - Stereotype loading (static, server-side)
  │  - Python subprocess execution (convert.py, main.py, infer.py)
  │  - Minimal error types (~5 classes)
  │
  ├─▶ WebSocket RPC ──▶ Browser Tab #1: BrowserRPCHandler
  │    POST {id, method, params} → handler runs on DiagramCore → {id, result}
  │
  ├─▶ WebSocket RPC ──▶ Browser Tab #2: BrowserRPCHandler
  │    (same protocol, different tab — different diagram)
  │
  └─▶ Subprocess ──▶ Python Pipeline (convert.py / main.py / infer.py)
       Server: queries browser for NNTree JSON → runs uv run python
```

**Key properties**:
- The browser's `DiagramCore` is the **only** copy of diagram state. The MCP server never holds nodes/edges.
- Multiple browser tabs can connect simultaneously. Each tab has its own independent diagram.
- The model uses `list_browser_tabs` to see all open tabs and `select_browser_tab` to pick which one to work with.
- If only one tab is connected, it's auto-selected — no user prompt needed.

### Multi-Tab Connection Lifecycle

```
Browser Tab opens localhost:5173
  → BrowserRPCHandler connects to ws://localhost:9339
  → Server assigns tab ID: "tab_1", stores WebSocket
  → Server pings tab for summary: { nodeCount, edgeCount }
  → Server auto-selects tab if it's the only one
  → Tab appears in list_browser_tabs output

Browser Tab #2 opens
  → Server assigns "tab_2"
  → Does NOT auto-select (ambiguity)
  → Model sees 2 tabs → asks user → select_browser_tab("tab_2")

Browser Tab closes
  → Server removes from client list
  → If it was the active tab, activeTabId becomes null
  → Model must call select_browser_tab to pick another

All tabs close
  → activeTabId = null
  → All mutation tools fail with "No browser connected"
  → list_stereotypes and pipeline tools still work
```

## 3. What Gets Removed

| Component | Lines | Reason |
|---|---|---|
| Server-side `DiagramCore` | — | State lives only in browser |
| `EventBus` (server usage) | ~66 | No server-side mutations to emit |
| `ws-server.ts` delta broadcast | 267 | Replaced by simple RPC request/response |
| `DiagramSyncClient.ts` | 249 | Replaced by `BrowserRPCHandler.ts` |
| `TransactionManager` | 163 | MCP calls already atomic; no use case for multi-step |
| `HistoryManager` | 149 | Inconsistent with browser undo; browser Ctrl+Z suffices |
| 14 MCP resources | 654 | Redundant with tools; model uses `get_graph` instead |
| `tools/events.ts` | 77 | No EventBus on server |
| `tools/transaction.ts` | 85 | No TransactionManager |
| `tools/history.ts` | 84 | No HistoryManager |
| `zodToJsonSchema` (custom) | ~60 | Can use `zod-to-json-schema` npm package |
| Error classes (txn/history/events) | ~50 | Only pipeline errors remain |
| `domainEventToDeltaOps` mapping | ~50 | No delta protocol |
| 12 `DomainEvent` types | ~40 | Only used by server for sync |
| `resources/index.ts` | 654 | No server-side state to query |

**Total removed: ~2500 lines from ~4700 in mcp-server.**

## 4. What Stays (Server-Side)

| Component | Lines | Why |
|---|---|---|
| `pipeline.ts` | 433 | Python subprocess execution (convert, train, infer) |
| MCP tool definitions | ~700 | Zod schemas + thin proxy handlers (~32 tools) |
| `server.ts` bootstrap | ~220 | Simplified: no DiagramCore, no resources |
| `browser-client.ts` | ~200 | WebSocket RPC client with multi-tab management |
| `tools/connection.ts` | ~60 | New: list_browser_tabs, select_browser_tab |
| Stereotype loader | ~60 | Static data, loaded at startup |
| Error classes (minimal) | ~60 | Pipeline errors + base class |

**Total server: ~900 lines (down from ~4700).**

## 5. What Gets Created

| File | Lines | Purpose |
|---|---|---|
| `front-end/src/sync/BrowserRPCHandler.ts` | ~200 | Receives RPC calls, executes on DiagramCore, returns results |
| `mcp-server/src/browser-client.ts` | ~200 | WebSocket server: accepts multiple browser tabs, routes RPC to selected tab |
| `mcp-server/src/tools/connection.ts` | ~60 | list_browser_tabs, select_browser_tab tools |

## 6. Phase-by-Phase Implementation Plan

### Phase 1: Browser RPC Handler (`front-end/`)

**New file**: `front-end/src/sync/BrowserRPCHandler.ts`

This replaces `DiagramSyncClient.ts`. It handles incoming WebSocket messages as RPC requests:

```typescript
// WebSocket message handler:
onMessage(msg) {
  const { id, method, params } = JSON.parse(msg);
  try {
    const result = await handleMethod(method, params, diagram);
    ws.send(JSON.stringify({ id, result }));
  } catch (err) {
    ws.send(JSON.stringify({ id, error: { message: err.message } }));
  }
}
```

**Methods implemented** (mapping to DiagramCore API calls):
- `get_graph` → `{ nodes: diagram.nodes, edges: diagram.edges }`
- `get_node` → `diagram.getNodeById(params.nodeId)` (returns Node or error)
- `get_edges` → filter edges by `params.nodeId` or all
- `get_subflow` → filter nodes/edges by `params.parentId`
- `graph_statistics` → compute counts + analysis helpers
- `list_stereotypes` → map `diagram.stereotypes` array
- `create_node` → `diagram.addModule()` or `diagram.addJoinNode()`
- `delete_nodes` → `diagram.deleteNodes()`
- `connect_nodes` → `diagram.addEdge()`
- `disconnect_nodes` → `diagram.removeEdge()`
- `move_nodes` → `diagram.moveNodes()`
- `duplicate_nodes` → iterate nodes, copy with offset
- `create_subflow` → `diagram.addSubGraph()`
- `set_parameter` / `update_parameters` / `reset_parameters` / `query_parameters` → `diagram.updateModule()`
- `select_nodes` / `clear_selection` / `get_selection` / `select_all` → DiagramCore selection methods
- `compile_nntree` → `new NNTree(diagram).toJson()` (returns NNTreeOutput)
- `export_diagram` → `diagram.exportToJson()`
- `import_diagram` → `diagram.importFromJson(params.json)`
- `validate_graph` / `validate_connections` / `validate_parameters` / `validate_subflows` → validation logic
- `reset_diagram` → clear nodes/edges arrays
- `ping` → `{ status: "ok", uptime, nodeCount, edgeCount }`

**Key decision**: NNTree compilation happens in the browser (it has DiagramCore). The server receives the JSON result and passes it to Python.

**Removed**: `DiagramSyncClient.ts` — no more delta application, no more snapshot/seq tracking.

**Modified**: `FlowCanvas.svelte` — replace `DiagramSyncClient` instantiation with `BrowserRPCHandler` instantiation. The connection URL stays the same (`ws://localhost:9339` or Vite-proxied `/ws`).

### Phase 2: Server WebSocket RPC Client (`mcp-server/`)

**New file**: `mcp-server/src/browser-client.ts`

A thin WebSocket client that connects to `ws://localhost:9339` and provides a promise-based RPC interface:

```typescript
export class BrowserClient {
  private ws: WebSocket;
  private pending = new Map<string, { resolve, reject }>();
  private nextId = 0;

  connect(): Promise<void> { /* connect, handle onopen/onclose */ }

  call<T>(method: string, params?: unknown): Promise<T> {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      // timeout after 30s
    });
  }

  private onMessage(data: string) {
    const { id, result, error } = JSON.parse(data);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (error) pending.reject(new Error(error.message));
    else pending.resolve(result);
  }
}
```

**Key property**: This is request/response, NOT delta broadcast. No sequence numbers, no snapshots, no domain events.

### Phase 3: Rewrite MCP Tools as Thin Proxies

Every tool handler becomes a one-liner:

```typescript
export const create_node = {
  schema: z.object({
    stereotype: z.string().min(1),
    position: z.object({ x: z.number(), y: z.number() }),
    config: z.object({...}).optional(),
  }),
  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("create_node", input);
  },
};
```

**ServerContext becomes**:
```typescript
export interface ServerContext {
  browser: BrowserClient;        // was: diagram: DiagramCore
  pipeline: typeof pipelineMod;   // unchanged
  stereotypes: StereotypeCore[];  // static, for list_stereotypes fallback
}
```

**Removed from ServerContext**: `diagram`, `transactions`, `history`, `eventBuffer`, `lastEventCursor`.

**Tools that stay server-only** (use `pipeline`, not browser):
- `execute_conversion` — queries browser for `compile_nntree` JSON, writes temp file, runs `convert.py`
- `execute_training` — runs `main.py`
- `execute_inference` — runs `infer.py`
- `list_stereotypes` — can use server-side static data (no browser query needed)

**Tools removed entirely**:
- `begin_transaction`, `commit`, `rollback` — no TransactionManager
- `undo`, `redo`, `get_history_status` — no HistoryManager
- `get_events` — no EventBus
- 14 resources — model uses `get_graph`/`get_node` tools instead

**Tools that become real (was stubs)**:
- `get_canvas_state`, `fit_view`, `center_view` — now actually execute in browser via Svelte Flow API

**Total MCP tools**: ~43 → ~30 (removing: 3 transaction, 3 history, 1 events, all 14 resources; merging: some validation tools)

### Phase 4: Simplify `server.ts`

```typescript
export async function createServer(stereotypesDir: string) {
  // 1. Load stereotypes (static data, no DiagramCore)
  const stereotypes = loadStereotypesFromDirectory(stereotypesDir);

  // 2. Connect to browser
  const browser = new BrowserClient();
  await browser.connect();

  // 3. Build context
  const ctx: ServerContext = { browser, pipeline: pipelineMod, stereotypes };

  // 4. Discover tools, register MCP server (same as before, but no resources)
  // ...
}
```

**Removed**: DiagramCore instantiation, EventBus subscriber, TransactionManager, HistoryManager, event buffer, all resource registration.

### Phase 5: Clean Up Error Classes

Keep only the error classes actually thrown:
- `MCPServerError` (base)
- `CompilationFailedError`
- `ConversionFailedError`
- `TrainingFailedError`
- `InferenceFailedError`

Remove: StereotypeNotFoundError, NodeNotFoundError, EdgeNotFoundError, ParameterNotFoundError, ParameterTypeMismatchError, TargetHandleOccupiedError, InvalidConnectionError, SelfLoopError, CycleDetectedError, InvalidPositionError, InvalidSubflowError, NoActiveTransactionError, TransactionAlreadyActiveError, NothingToUndoError, NothingToRedoError, ImportFailedError, ExportFailedError.

(These errors are now handled by the BrowserRPCHandler — the browser's DiagramCore methods throw, and the error message propagates back to the model via the RPC response.)

### Phase 6: Update Tests

**Tests to rewrite**:
- `mcp-server/__tests__/tools.test.ts` (530 lines) — currently creates server-side DiagramCore; rewrite to mock `BrowserClient`
- `mcp-server/__tests__/websocket.test.ts` — rewrite for RPC protocol (was delta protocol)
- `front-end/src/__tests__/DiagramSyncClient.test.ts` — replace with `BrowserRPCHandler.test.ts`

**Tests to remove**:
- `mcp-server/__tests__/integration.test.ts` — if it tests server-side state

**Tests unaffected**:
- `front-end/src/__tests__/nnTree.test.ts` — NNTree still fully functional
- `converted/src/tests/*` — Python pipeline unchanged
- `front-end/src/__tests__/integration/*` — integration tests unchanged

### Phase 7: Update Dependencies

**Add**: `zod-to-json-schema` npm package (replaces custom converter)
**Remove**: None needed — ws stays, zod stays, @modelcontextprotocol/sdk stays

## 7. Risk Assessment

| Risk | Impact | Mitigation |
|---|---|---|
| Browser not connected when tool is called | Tool fails with "no browser connected" error | Server can queue requests or return clear error; this is the expected behavior — the model needs a browser to interact with |
| Increased latency (extra WebSocket round-trip per tool call) | ~1-5ms localhost, negligible vs LLM response time | WebSocket is already open; request/response on localhost is sub-millisecond |
| NNTree compilation in browser ties up UI thread | Brief freeze for large diagrams | Compilation is fast (< 50ms for typical diagrams); can be made async |
| Losing undo/redo for MCP-initiated mutations | Model can't undo via MCP | The browser's native Ctrl+Z still works; if model-level undo is needed later, it can be re-added as browser-side history |
| Breaking existing integration test pipeline | Tests won't compile | Phase 6 addresses tests; integration tests use Python pipeline (unchanged) |

## 8. Line Count Summary

| Module | Before | After | Delta |
|---|---|---|---|
| `mcp-server/src/server.ts` | 363 | ~200 | -163 |
| `mcp-server/src/ws-server.ts` | 267 | 0 (replaced) | -267 |
| `mcp-server/src/transaction.ts` | 163 | 0 | -163 |
| `mcp-server/src/history.ts` | 149 | 0 | -149 |
| `mcp-server/src/errors.ts` | 171 | ~60 | -111 |
| `mcp-server/src/resources/index.ts` | 654 | 0 | -654 |
| `mcp-server/src/tools/*` (11 files) | ~2100 | ~600 | -1500 |
| `mcp-server/src/browser-client.ts` | 0 | ~100 | +100 |
| `front-end/src/sync/DiagramSyncClient.ts` | 249 | 0 | -249 |
| `front-end/src/sync/BrowserRPCHandler.ts` | 0 | ~200 | +200 |
| **Net change** | ~4116 | ~1160 | **-2956** |

## 9. Approval Checklist

Before implementation begins, confirm:

- [ ] **Headless mode**: Do we accept that MCP tools requiring browser state will fail when no browser is connected? (The model/user would need to open the browser first.)
- [ ] **Undo/redo removal**: OK to remove server-side undo/redo? Browser Ctrl+Z still works.
- [ ] **Transaction removal**: OK to remove atomic multi-step transactions? Each MCP tool call is already atomic.
- [ ] **Resource removal**: OK to remove 14 MCP resources? Functionally identical to tools like `get_graph`.
- [ ] **NNTree in browser**: OK to compile NNTree on the browser side? Server receives JSON result.
