# MCP Server Architecture Review: Identified Overengineering Issues

## Premise

The MCP server currently maintains a **full server-side copy of the diagram state** (`DiagramCore` instance), then uses a real-time WebSocket delta protocol to keep the browser's `$state.raw` arrays in sync. This introduces needless complexity. The core question: **why not simply ask the browser what's on the canvas?**

---

## Problem 1: Duplicated `DiagramCore` in the MCP Server

`mcp-server/src/server.ts:230-236` creates a headless `DiagramCore` identical to the browser's. On WebSocket connect, the browser sends `push_state` with its entire node/edge list (`DiagramSyncClient.ts:134-143`), the server imports it via `importFromJson` (a method designed for file deserialization, not real-time sync), then echoes a snapshot back. The state flow is: browser → server → browser.

The server **does not need its own `DiagramCore`**. Every MCP tool could read the canvas state directly from the browser via a simple WebSocket request/response, eliminating the entire sync machinery.

---

## Problem 2: EventBus + Domain Events + Delta Protocol (~500 lines spread across 4 files)

An event-sourcing system built from scratch:

- `EventBus` with monotonic `seq`, 1000-entry ring buffer, `getEventsSince` for late subscribers
- 12 typed `DomainEvent` types (`node_created`, `node_deleted`, `edge_created`, etc.)
- `domainEventToDeltaOps()` mapping every event type to one or more `DeltaOperation`s
- A separate `broadcastSeq` counter (`ws-server.ts:43`) to avoid gaps from skipped `graph_changed` events
- Sequence gap detection in the browser with automatic snapshot fallback
- Exponential backoff reconnection

All of this exists **only** because the server holds a second copy of the state. Without it, mutations happen directly in the browser: the LLM says "create a node" → browser does it → done.

---

## Problem 3: TransactionManager (163 lines, mcp-server/src/transaction.ts)

Snapshot-based atomic transactions with buffered mutations and rollback via `restoreSnapshot`. In practice, MCP tool calls are already atomic — there is no realistic use case where an LLM opens a transaction, issues 3 tool calls, then commits. The rollback-via-snapshot approach is equivalent to simply not having server-side state at all.

---

## Problem 4: HistoryManager / Undo-Redo (149 lines, mcp-server/src/history.ts)

Maintains a 50-entry snapshot stack for undo/redo on the server side. Problems:

- The browser already has native undo (Ctrl+Z in Svelte Flow)
- The two undo systems are **inconsistent** — undoing via Ctrl+Z in the browser does not update the server's history, and vice versa
- Every mutating MCP tool pushes a snapshot (`graph.ts:69`), storing a full copy of the diagram state
- 50 snapshots × ~100 nodes each = wasted memory

---

## Problem 5: 22 Error Classes (errors.ts)

Every error condition is a separate class: `StereotypeNotFoundError`, `NodeNotFoundError`, `EdgeNotFoundError`, `InvalidPositionError`, `SelfLoopError`, `CycleDetectedError`, `InvalidSubflowError`, `CompilationFailedError`, `ConversionFailedError`, `TrainingFailedError`, `InferenceFailedError`, `NoActiveTransactionError`, `TransactionAlreadyActiveError`, `NothingToUndoError`, `NothingToRedoError`, `ImportFailedError`, `ExportFailedError`. Most duplicate validation already present in `DiagramCore` or `checkValidConnection`.

---

## Problem 6: 14 MCP Resource Definitions

Read-only resources like `nnmodelling://node/{id}`, `nnmodelling://diagram/current`, `nnmodelling://stereotypes`, `nnmodelling://validation` — all views of the server-side `DiagramCore`. Without a server-side copy, the LLM could use a simple `get_graph` tool, or just look at the browser via glimpse.

---

## Problem 7: Custom `zodToJsonSchema` Converter (server.ts:88-149)

A hand-rolled converter mapping Zod types (`ZodObject`, `ZodString`, `ZodArray`, etc.) to JSON Schema for MCP's `ListTools` output. The npm package `zod-to-json-schema` already exists. This is a symptom of a larger issue: the tool definitions are unnecessarily complex.

---

## Problem 8: `push_state` → `importFromJson` Round-Trip on Connect

On WebSocket connect, the browser serializes its entire state and sends it to the server (`push_state`). The server deserializes it via `importFromJson` (built for file-based save/load, not real-time sync), then re-serializes and sends a snapshot back. This is the clearest evidence that the architecture is forced — the server is fighting to maintain a copy of state it should never have owned.

---

## Summary

| Component | Lines | What It Duplicates |
|---|---|---|
| Server-side `DiagramCore` | ~574 | Same business logic in the browser |
| `EventBus` + event types | ~200 | Needed only because of the second state |
| `ws-server.ts` | 267 | Complex delta protocol for sync |
| `DiagramSyncClient.ts` | 249 | Applies deltas to `$state.raw` |
| `TransactionManager` | 163 | Unused; rollback = restoreSnapshot |
| `HistoryManager` | 149 | Inconsistent with browser undo |
| `errors.ts` | ~150 | Duplicates frontend validation |
| `zodToJsonSchema` | ~60 | Re-invented wheel |
| 14 resources | ~250 | Replaceable by `get_graph` tool |

**Total duplicated effort: ~2000 lines out of ~4000 in the MCP server.**

The root cause is a single architectural decision: **the MCP server owns a copy of the diagram state**. Removing that eliminates the EventBus, the delta protocol, the TransactionManager, the HistoryManager, half the error classes, all the resources, and the `push_state`/`importFromJson` sync dance. The MCP server becomes a thin proxy that reads from and writes to the browser's actual state.

### Now how can we fix it?

I want a simple tool that can simply ask to the browser questions about the diagram and gives token efficient responses
to the model.

So a model can debug better. I want you to simplify this implementation. Make a plan, then I will decide to approve it or not.
