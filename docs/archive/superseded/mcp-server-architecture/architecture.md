# MCP Server Architecture for NNModelling

**Status**: Design Document  
**Date**: 2026-06-30  
**Author**: NNModelling Architect  
**Version**: 2.0 — Real-time sync architecture

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Component Diagram](#2-component-diagram)
3. [Shared Core Extraction](#3-shared-core-extraction)
4. [State Synchronization Model](#4-state-synchronization-model)
5. [MCP Resource Model](#5-mcp-resource-model)
6. [MCP Tool Catalogue](#6-mcp-tool-catalogue)
7. [API Naming Conventions](#7-api-naming-conventions)
8. [Sequence Diagrams](#8-sequence-diagrams)
9. [Transaction Model](#9-transaction-model)
10. [Undo / Redo Model](#10-undo--redo-model)
11. [Event Model](#11-event-model)
12. [Error Model](#12-error-model)
13. [LLM Interaction Flow with glimpse](#13-llm-interaction-flow-with-glimpse)
14. [Extensibility](#14-extensibility)
15. [Future Evolution Roadmap](#15-future-evolution-roadmap)
16. [Implementation Plan](#16-implementation-plan)

---

## 1. High-Level Architecture

### 1.1 Core Principle

The MCP server acts as a **headless diagram manipulator** — a process that holds a live `DiagramCore` instance in memory and exposes its complete API as MCP tools. The browser UI (Svelte + Svelte Flow) is a **reactive rendering target**, not the state authority. State flows in real time:

```
MCP Server (state authority + WebSocket server)
    │
    ├──▶ stdio (MCP protocol) ──▶ LLM Agent (manipulation)
    │
    ├──▶ WebSocket (ws://) ──▶ Browser UI (Svelte Flow)
    │        │                    │
    │        │    Incremental     │  Reactive rendering via
    │        │    delta updates   │  DiagramSyncClient
    │        │    (not snapshots) │
    │        │                    │
    │        │                    └──▶ glimpse MCP — screenshots, DOM, accessibility
    │
    └──▶ Subprocess ──▶ Python Pipeline (convert.py, main.py, infer.py)
```

**Key design**: Every mutation in `DiagramCore` emits a typed domain event on an internal event bus. The WebSocket layer subscribes to this bus and broadcasts **incremental delta updates** (not full graph snapshots) to connected browsers. The browser's `DiagramSyncClient` receives these deltas and applies them directly to the reactive `$state.raw` arrays — no manual reloads, no file exchange, no polling. The LLM creates a node via MCP, and the browser updates within milliseconds.

### 1.2 Three-Agent Model

The system is designed for a **multimodal LLM agent** that coordinates three capabilities:

| Capability | Provider | Purpose |
|-----------|----------|---------|
| **Perception** | `glimpse` MCP | See the canvas (screenshots), inspect DOM, check accessibility |
| **Manipulation** | `nnmodelling` MCP (this design) | Create nodes, connect edges, set params, compile, convert, train |
| **Reasoning** | LLM itself | Plan graph topology, debug compilation errors, choose hyperparameters |

### 1.3 Process Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  nnmodelling-mcp-server (Node.js process, stdio + WebSocket)     │
│                                                                  │
│  ┌─────────────────┐   ┌──────────────────────────────────┐     │
│  │ MCP Protocol     │   │  Application Layer                │     │
│  │ (stdio transport)│   │                                  │     │
│  │                  │   │  ┌────────────────────────────┐  │     │
│  │  ListTools       │   │  │  Tool Handlers             │  │     │
│  │  CallTool ───────┼──▶│  │  (one per tool)            │  │     │
│  │  ListResources   │   │  └────────────┬───────────────┘  │     │
│  │  ReadResource    │   │               │                  │     │
│  └─────────────────┘   │               ▼                  │     │
│                         │  ┌────────────────────────────┐  │     │
│                         │  │  Transaction Mgr           │  │     │
│                         │  └────────────┬───────────────┘  │     │
│                         │               │                  │     │
│                         │               ▼                  │     │
│                         │  ┌────────────────────────────┐  │     │
│                         │  │  DiagramCore                │  │     │
│                         │  │  (state authority)          │  │     │
│                         │  │      │                      │  │     │
│                         │  │      │ every mutation       │  │     │
│                         │  │      ▼                      │  │     │
│                         │  │  ┌──────────────────────┐   │  │     │
│                         │  │  │  EventBus (internal)  │   │  │     │
│                         │  │  │  typed domain events  │   │  │     │
│                         │  │  └──────┬───────────────┘   │  │     │
│                         │  └─────────┼───────────────────┘  │     │
│                         │            │                      │     │
│  ┌──────────────────┐   │  ┌─────────┴───────────────┐      │     │
│  │  WebSocket Server  │   │  │  MCP Event Polling      │      │     │
│  │  (ws://, port NNN) │◀──┼──│  (get_events tool)      │      │     │
│  │                    │   │  └─────────────────────────┘      │     │
│  │  Broadcasts delta  │   │                                  │     │
│  │  updates to        │   │  ┌────────────────────────────┐  │     │
│  │  browser clients   │   │  │  StereotypeCore             │  │     │
│  └────────┬───────────┘   │  │  NNTree compiler            │  │     │
│           │               │  │  Connection checker         │  │     │
│           │               │  └────────────┬───────────────┘  │     │
│           │               │               │                  │     │
│           │               │  ┌────────────┴───────────────┐  │     │
│           │               │  │  History Manager            │  │     │
│           │               │  │  Python Pipeline (spawn)    │  │     │
│           │               │  └────────────────────────────┘  │     │
│           │               └──────────────────────────────────┘     │
└───────────┼──────────────────────────────────────────────────────┘
            │                              │
            ▼                              ▼
┌───────────────────────┐      ┌─────────────────────┐
│  Browser (Svelte)      │      │  Python Pipeline     │
│                        │      │  (subprocess)        │
│  DiagramSyncClient     │      │                      │
│  receives delta msgs   │      │  convert.py          │
│  applies to $state.raw │      │  main.py (train)     │
│                        │      │  infer.py            │
│  └──▶ glimpse MCP      │      └─────────────────────┘
│       (screenshots)    │
└───────────────────────┘
```

### 1.4 Real-Time State Sync with Browser

The MCP server is **state authority**. The browser is a **reactive view**. Synchronization is real-time via WebSocket:

1. **Server startup**: MCP server starts a WebSocket server on a configurable port (default: `ws://localhost:9339`).
2. **Browser connect**: Browser's `DiagramSyncClient` opens a WebSocket connection on page load.
3. **Initial handshake**: Server sends the **full current diagram state** (snapshot) as the first message, tagged with a monotonic `seq` number.
4. **Incremental updates**: Every mutation to `DiagramCore` emits a typed `DomainEvent` on the internal `EventBus`. The WebSocket layer subscribes to the bus, converts each event to a compact delta message, and broadcasts it to all connected browsers.
5. **Browser apply**: `DiagramSyncClient` receives the delta message and directly mutates `diagram.nodes` and `diagram.edges` (both `$state.raw` arrays). Svelte 5 reactivity triggers an instant UI update.
6. **Disconnect / reconnect**: On reconnect, the server sends the full current snapshot (at the latest `seq`) to reconcile state.

**No file exchange required.** The LLM calls `create_node(...)` via MCP, and the browser canvas updates within milliseconds. The `export_diagram` and `import_diagram` tools remain available for persistence and cross-session save/load, but they are **not required** for the real-time visual workflow.

### 1.5 Why Real-Time Sync Matters for LLM Agents

| Without real-time sync | With real-time sync |
|---|---|
| LLM calls `export_diagram` → agent switches to browser → clicks Load → waits for render → screenshots | LLM calls `create_node` → MCP server emits delta → browser updates in <10ms → agent screenshots immediately |
| 3-5 second round-trip per edit cycle | Sub-second visual feedback |
| File system dependency; fragile paths | Pure in-process + in-memory; no I/O |
| Browser state can drift from server state | Browser is always a faithful mirror |

The LLM's edit-verify loop (see §14) becomes dramatically faster: manipulate → browser auto-updates → screenshot → next edit. No intervening human-style steps.

---

## 2. Component Diagram

### 2.1 Package Structure

```
NNModelling/
│
├── front-end/                              # Existing Svelte app (modified)
│   ├── src/
│   │   ├── core/                           # ★ NEW: shared core (no Svelte deps)
│   │   │   ├── DiagramCore.ts              # Pure TS diagram state + EventBus
│   │   │   ├── EventBus.ts                 # ★ NEW: typed domain event emitter
│   │   │   ├── DomainEvents.ts             # ★ NEW: event type definitions + payloads
│   │   │   ├── types.ts                    # Shared type definitions (incl. DeltaMessage)
│   │   │   ├── StereotypeCore.ts           # Pure TS stereotype loader
│   │   │   └── validation.ts               # Connection validation
│   │   ├── sync/                           # ★ NEW: browser-side sync client
│   │   │   └── DiagramSyncClient.ts        # WebSocket client, applies deltas to $state.raw
│   │   ├── Diagram.svelte.ts               # MODIFIED: wraps DiagramCore + $state.raw
│   │   ├── stereotype.ts                   # MODIFIED: delegates to StereotypeCore
│   │   ├── conversion/
│   │   │   └── nnTree.ts                   # MODIFIED: takes DiagramCore
│   │   ├── utils.ts                        # MODIFIED: takes DiagramCore
│   │   └── ... (rest of Svelte app unchanged)
│   └── package.json                        # MODIFIED: exports core/ and sync/ subpaths
│
├── mcp-server/                             # ★ NEW: MCP server package
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   └── src/
│       ├── index.ts                        # Entry point: MCP + WebSocket bootstrap
│       ├── server.ts                       # MCP server setup + tool registration
│       ├── ws-server.ts                    # ★ NEW: WebSocket server + delta broadcaster
│       ├── tools/
│       │   ├── graph.ts                    # createNode, deleteNode, connectNodes, ...
│       │   ├── parameters.ts               # setParameter, updateParameters, ...
│       │   ├── selection.ts                # selectNodes, clearSelection, ...
│       │   ├── canvas.ts                   # zoom, centerView, fitView
│       │   ├── validation.ts               # validateGraph, validateConnections, ...
│       │   ├── conversion.ts               # compileNNTree, exportDiagram, executeConversion
│       │   ├── inspection.ts               # getGraph, getNode, getEdges, ...
│       │   └── transaction.ts              # beginTransaction, commit, rollback
│       ├── resources/
│       │   └── index.ts                    # MCP resource definitions
│       ├── history.ts                      # Undo/redo snapshot manager
│       ├── transaction.ts                  # Transaction lifecycle manager
│       ├── events.ts                       # Event bus + MCP polling adapter
│       ├── errors.ts                       # Error type hierarchy
│       └── pipeline.ts                     # Python subprocess interface
│
├── pnpm-workspace.yaml                     # ★ NEW: workspace config
└── package.json                            # MODIFIED: root workspace scripts
```

### 2.2 Module Dependency Graph

```
Browser (Svelte)
  │
  ├──▶ Diagram.svelte.ts (wraps DiagramCore + $state.raw)
  │        │
  │        └──▶ front-end/src/core/DiagramCore.ts
  │
  └──▶ front-end/src/sync/DiagramSyncClient.ts
           │
           │  WebSocket (ws://) ────────────┐
           │                                │
           ▼                                │
mcp-server/src/ws-server.ts ◀───────────────┘
  │     subscribes to EventBus
  │
  ├──▶ front-end/src/core/EventBus.ts     ◀── also used by:
  │        │                                    mcp-server/src/events.ts (MCP polling)
  │        │                                    mcp-server/src/ws-server.ts (WS broadcast)
  │        │
  │        └──▶ front-end/src/core/DomainEvents.ts
  │
  ├──▶ front-end/src/core/DiagramCore.ts
  │        │
  │        ├── emits events on every mutation
  │        │
  │        ├──▶ front-end/src/core/StereotypeCore.ts
  │        │        │
  │        │        └──▶ Stereotypes/**/*.json (via fs, not Vite glob)
  │        │
  │        ├──▶ front-end/src/core/types.ts
  │        │
  │        ├──▶ front-end/src/core/validation.ts
  │        │
  │        └──▶ front-end/src/conversion/nnTree.ts

mcp-server/src/tools/*.ts
    │
    ├──▶ mcp-server/src/transaction.ts
    │        │
    │        └──▶ mcp-server/src/history.ts
    │
    ├──▶ mcp-server/src/errors.ts
    │
    ├──▶ mcp-server/src/pipeline.ts
    │        │
    │        └──▶ Python subprocess (convert.py, main.py, infer.py)
    │
    └──▶ front-end/src/core/DiagramCore.ts
```

### 2.3 Key Dependency Decisions

| Dependency | Decision | Rationale |
|-----------|----------|-----------|
| `$state.raw` (Svelte rune) | Removed from core | MCP server runs in plain Node.js; Svelte compiler is absent |
| `import.meta.glob` (Vite) | Replaced with `fs.readdirSync` | MCP server has no Vite; StereotypeCore provides a Node-compatible loader |
| `@xyflow/svelte` types | Re-exported in `core/types.ts` | Only the **type definitions** (Node, Edge) are needed; runtime is not |
| `@modelcontextprotocol/sdk` | New dependency | Canonical MCP TypeScript SDK |
| `ws` (npm) | New dependency | Lightweight WebSocket server library; zero native deps, widely used |
| `zod` | New dependency | Runtime validation of all tool inputs, outputs, and WebSocket messages |
| `nnTree.ts` | Modified to accept `DiagramCore` | Currently takes `Diagram`; minimal interface change |
| `EventBus` | New shared module in `core/` | Single emitter used by MCP server tools AND WebSocket server; avoids duplication |
| `DiagramSyncClient` | New browser-side module in `sync/` | Standalone class; connects via WebSocket, applies deltas to `$state.raw` arrays |

### 2.4 WebSocket Protocol — Technology Choice

| Candidate | Verdict | Rationale |
|-----------|---------|-----------|
| `ws` (npm) | **Selected** | Lightweight (no native addons), event-driven API, 85M weekly downloads, used by Vite's HMR |
| `socket.io` | Rejected | Adds protocol layer overhead; the custom delta protocol is simple enough to run over raw WebSocket |
| `uWebSockets.js` | Rejected | C++ native addon; complicates build, overkill for single-browser use case |
| SSE (Server-Sent Events) | Rejected | Unidirectional (server→client only); future needs client→server mutations for undo/redo broadcast

---

## 3. Shared Core Extraction

### 3.1 The Refactoring

The existing `Diagram.svelte.ts` is the sole state authority. To make it MCP-compatible, we extract a **pure TypeScript core** that has zero Svelte dependencies:

```
Diagram.svelte.ts (current)
    │
    ├── Svelte-specific: $state.raw
    ├── Business logic: addNode, deleteNode, connectNodes, etc.
    └── Type deps: @xyflow/svelte (Node, Edge types)

                    ▼ EXTRACT

DiagramCore.ts (new, pure TS)
    │
    ├── Plain arrays: nodes: Node[], edges: Edge[]
    ├── All business logic unchanged
    └── Type deps: @xyflow/svelte types only (no runtime)

Diagram.svelte.ts (new, thin wrapper)
    │
    ├── extends DiagramCore
    ├── Overrides nodes/edges with $state.raw
    └── All Svelte-specific code here
```

### 3.2 DiagramCore Interface (TypeScript)

```typescript
// front-end/src/core/DiagramCore.ts

import { type Node, type Edge } from "@xyflow/svelte";
import { StereotypeCore } from "./StereotypeCore";
import { EventBus } from "./EventBus";
import { NNTree } from "../conversion/nnTree";

export interface DiagramCoreSnapshot {
  nodes: Node[];
  edges: Edge[];
}

export class DiagramCore {
  // ── State ──────────────────────────────────────
  public nodes: Node[];
  public edges: Edge[];
  public stereotypes: StereotypeCore[];

  // ── Event Bus ──────────────────────────────────
  // Every mutation emits a typed DomainEvent.
  // Subscribers: WebSocket server (broadcasts to browsers),
  //              MCP event polling (get_events tool),
  //              HistoryManager (undo/redo snapshots).
  public readonly events: EventBus;

  // ── Stereotype ─────────────────────────────────
  getStereotype(name: string): StereotypeCore | undefined;

  // ── Node CRUD ──────────────────────────────────
  addModule(
    stereotype: StereotypeCore,
    x: number,
    y: number,
    config?: {
      name?: string;
      color?: string;
      width?: number;
      height?: number;
      params?: Record<string, any>;
    }
  ): Node;
  addJoinNode(
    stereotype: StereotypeCore,
    x: number,
    y: number,
    config?: {
      name?: string;
      inputsCount?: number;
      color?: string;
      params?: Record<string, any>;
    }
  ): Node;
  addSubGraph(x: number, y: number): Node;
  updateNode(
    id: string,
    config: {
      name?: string;
      color?: string;
      width?: number;
      height?: number;
      params?: Record<string, any>;
      stereotype?: string;
      position?: { x: number; y: number };
    }
  ): Node;
  deleteNodes(ids: string[]): void;
  deleteEdges(edgeIds: string[]): void;
  deleteNode(id: string): void;        // convenience: delegates to deleteNodes
  deleteEdge(edgeId: string): void;    // convenience: delegates to deleteEdges
  getNodeById(id: string): Node | undefined;

  // ── Connection ─────────────────────────────────
  addEdge(
    source: string,
    target: string,
    sourceHandle?: string,
    targetHandle?: string
  ): Edge;
  removeEdge(source: string, target: string, targetHandle?: string): void;
  reconnectEdge(
    edgeId: string,
    newSource?: string,
    newTarget?: string,
    newSourceHandle?: string,
    newTargetHandle?: string
  ): void;

  // ── Position ───────────────────────────────────
  moveNode(id: string, x: number, y: number): void;
  moveNodes(positions: Array<{ id: string; x: number; y: number }>): void;

  // ── Graph Queries ──────────────────────────────
  getChildren(id: string): Node[];
  getParents(id: string): Node[];
  getSubflowNodes(parentId: string): Node[];
  getSubflowEdges(parentId: string): Edge[];

  // ── Selection ──────────────────────────────────
  selectNodes(ids: string[]): void;
  clearSelection(): void;
  getSelectedNodes(): Node[];
  getSelectedEdges(): Edge[];

  // ── Subflow ────────────────────────────────────
  toggleSubflow(parentId: string, collapse: boolean): void;

  // ── Serialization ──────────────────────────────
  exportToJson(): string;
  importFromJson(jsonString: string): void;
  getSnapshot(): DiagramCoreSnapshot;
  restoreSnapshot(snapshot: DiagramCoreSnapshot): void;

  // ── Compilation ────────────────────────────────
  compileNNTree(): NNTree;

  // ── Validation ─────────────────────────────────
  checkValidConnection(
    source: string,
    target: string,
    sourceHandle?: string,
    targetHandle?: string
  ): boolean;

  // ── Identity ───────────────────────────────────
  nextNodeName(stereotype: string, baseName?: string): string;
}

// Derived getters (non-reactive, computed on access):
//   get layerStereotypes(): StereotypeCore[]
//   get joinStereotypes(): StereotypeCore[]

// Private helpers extracted from current Diagram:
//   private getDefaultParams(stereotype: StereotypeCore): Record<string, any>
```

### 3.3 StereotypeCore Interface

```typescript
// front-end/src/core/StereotypeCore.ts

export interface ModuleParameter {
  type: string;
  default: string;
  position?: "top" | "bottom";
}

export interface StereotypeView {
  color: string;
  width: number;
  height: number;
}

export interface StereotypeJson {
  category?: string;
  pythonClassName?: string;
  taskType?: "classification" | "regression";
  expr?: string;
  view?: Partial<StereotypeView>;
  params?: Record<string, ModuleParameter>;
}

export class StereotypeCore {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly pythonClassName: string;
  readonly taskType: string;
  readonly expr: string;
  readonly parameters: Record<string, ModuleParameter>;
  readonly view: StereotypeView;
  readonly isJoin: boolean;
  readonly isInput: boolean;
  readonly isLoss: boolean;
  readonly isSubFlow: boolean;

  constructor(filePath: string, data: StereotypeJson);

  // Two loading strategies:
  // Vite loader (for browser):
  static loadFromDirectory(): StereotypeCore[];   // uses import.meta.glob

  // Node.js loader (for MCP server):
  static loadFromDirectoryNode(stereotypesDir: string): StereotypeCore[];
  // uses fs.readdirSync + JSON.parse
  // Throws if import.meta.glob is available (should call loadFromDirectory)
}
```

### 3.4 Validation Module Interface

```typescript
// front-end/src/core/validation.ts

export interface ConnectionValidation {
  valid: boolean;
  reason?: string;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  code: string;          // machine-readable error code
  message: string;       // human-readable message
  nodeId?: string;       // affected node (if applicable)
  edgeId?: string;       // affected edge (if applicable)
}

export interface ValidationWarning {
  code: string;
  message: string;
  nodeId?: string;
}

export function checkValidConnection(
  edges: Edge[],
  source: string,
  target: string,
  sourceHandle?: string,
  targetHandle?: string
): ConnectionValidation;

export function validateGraph(diagram: DiagramCore): GraphValidationResult;
export function validateConnections(diagram: DiagramCore): GraphValidationResult;
export function validateParameters(diagram: DiagramCore): GraphValidationResult;
export function validateSubflows(diagram: DiagramCore): GraphValidationResult;
```

### 3.5 Types Module

```typescript
// front-end/src/core/types.ts

import { type Node, type Edge } from "@xyflow/svelte";

// Re-export Svelte Flow types for consumers
export type { Node, Edge };

// ── Domain Events (EventBus) ──────────────────

export type DomainEventType =
  | "node_created"
  | "node_deleted"
  | "node_updated"
  | "node_moved"
  | "edge_created"
  | "edge_deleted"
  | "edge_reconnected"
  | "subflow_toggled"
  | "selection_changed"
  | "graph_changed"
  | "diagram_reset"
  | "diagram_imported";

export interface DomainEvent<T = Record<string, unknown>> {
  type: DomainEventType;
  seq: number;                // Monotonically increasing sequence number
  timestamp: number;           // Unix ms
  transactionId?: string;
  payload: T;
}

// ── WebSocket Messages ─────────────────────────

export type WSMessageType =
  | "snapshot"                 // Full state on connect/reconnect
  | "delta";                   // Incremental update

export interface WSSnapshotMessage {
  type: "snapshot";
  seq: number;                 // Sequence number of this snapshot
  nodes: Node[];
  edges: Edge[];
}

export interface WSDeltaMessage {
  type: "delta";
  seq: number;                 // Monotonic; clients track lastSeen
  operations: DeltaOperation[];
}

export type DeltaOperation =
  | { op: "node_added";    nodeId: string; data: Partial<Node> }
  | { op: "node_removed";  nodeId: string }
  | { op: "node_moved";    nodeId: string; position: { x: number; y: number } }
  | { op: "node_updated";  nodeId: string; changes: Record<string, unknown> }
  | { op: "edge_added";    edgeId: string; data: Partial<Edge> }
  | { op: "edge_removed";  edgeId: string }
  | { op: "edge_reconnected"; edgeId: string; changes: Record<string, unknown> }
  | { op: "selection_changed"; nodeIds: string[]; edgeIds: string[] }
  | { op: "graph_reset";   nodes: Node[]; edges: Edge[] };  // Full reset (e.g., import)

// Wraps the full diagram state sent on WebSocket connect
export interface WSInitialState {
  seq: number;
  nodes: Node[];
  edges: Edge[];
}

// ── Position ────────────────────────────────────
export interface Position {
  x: number;
  y: number;
}

// Node configuration for creation
export interface NodeConfig {
  name?: string;
  color?: string;
  width?: number;
  height?: number;
  params?: Record<string, any>;
}

export interface ModuleNodeConfig extends NodeConfig {
  // module-specific fields (none currently beyond NodeConfig)
}

export interface JoinNodeConfig extends NodeConfig {
  inputsCount?: number;
}

// Edge configuration
export interface EdgeConfig {
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

// Selection
export interface Selection {
  nodeIds: string[];
  edgeIds: string[];
}

// Snapshot for undo/redo/transactions
export interface DiagramSnapshot {
  nodes: Node[];
  edges: Edge[];
  timestamp: number;
  description: string;
}

// Canvas state (from Svelte Flow viewport)
export interface CanvasState {
  zoom: number;
  x: number;
  y: number;
}

// Graph statistics
export interface GraphStatistics {
  nodeCount: number;
  edgeCount: number;
  moduleCount: number;
  joinCount: number;
  subflowCount: number;
  inputCount: number;
  lossCount: number;
  maxDepth: number;
  avgFanOut: number;
  cycleFree: boolean;
}

// Compiled NNTree output
export interface NNTreeOutput {
  json: string;
  root: string;
  nodeCount: number;
  subflowCount: number;
  lossNodeType: string | null;
}
```

---

## 4. State Synchronization Model

### 4.1 Architecture Overview

The synchronization model has three layers:

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: EventBus (internal, in-process)                       │
│                                                                 │
│  DiagramCore mutation → DomainEvent(type, seq, payload)          │
│                                                                 │
│  Subscribers:                                                    │
│    ├── WebSocket server (ws-server.ts) → broadcast to browsers   │
│    ├── MCP event buffer (events.ts) → get_events() tool          │
│    └── HistoryManager → undo/redo snapshots                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 2: WebSocket Transport (process-local, TCP)              │
│                                                                 │
│  ws-server.ts subscribes to EventBus.                           │
│  On each DomainEvent:                                            │
│    1. Converts to DeltaOperation (compact, additive)            │
│    2. Wraps in WSDeltaMessage { type:"delta", seq, operations } │
│    3. Broadcasts JSON to all connected browsers                 │
│                                                                 │
│  On browser connect:                                             │
│    1. Takes DiagramCore.getSnapshot()                           │
│    2. Sends WSSnapshotMessage { type:"snapshot", seq, nodes,    │
│       edges } as first message                                  │
│    3. Subsequent mutations arrive as delta messages              │
│                                                                 │
│  On browser reconnect:                                           │
│    1. Sends full snapshot at current seq                        │
│    2. Browser discards any stale state and applies snapshot     │
└──────────────────────────┬──────────────────────────────────────┘
                           │  ws://localhost:9339
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3: Browser Sync Client (Svelte app)                      │
│                                                                 │
│  DiagramSyncClient:                                              │
│    - Opens WebSocket on mount                                    │
│    - On "snapshot" → replaces diagram.nodes + diagram.edges     │
│    - On "delta" → applies each DeltaOperation to $state.raw     │
│    - Tracks lastSeenSeq for reconnect detection                 │
│    - Auto-reconnects with exponential backoff                   │
│                                                                 │
│  Svelte 5 reactivity:                                            │
│    diagram.nodes = $state.raw<Node[]>([...updated])              │
│    diagram.edges = $state.raw<Edge[]>([...updated])              │
│    → FlowCanvas auto re-renders                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 EventBus Design

The `EventBus` is a simple typed event emitter shared between `DiagramCore` (producer) and all subscribers (consumers). It lives in `front-end/src/core/EventBus.ts` — pure TypeScript, zero dependencies.

```typescript
// front-end/src/core/EventBus.ts

import type { DomainEvent, DomainEventType } from "./types";

export type EventHandler<T = Record<string, unknown>> = (event: DomainEvent<T>) => void;

export class EventBus {
  private handlers: Map<DomainEventType, Set<EventHandler<any>>> = new Map();
  private seq: number = 0;
  private buffer: DomainEvent[] = [];         // Ring buffer for late subscribers
  private maxBufferSize: number = 1000;

  /** Subscribe to a specific event type. Returns unsubscribe function. */
  on<T>(type: DomainEventType, handler: EventHandler<T>): () => void;

  /** Subscribe to ALL event types (used by ws-server for broadcast). */
  onAny(handler: EventHandler): () => void;

  /** Emit an event. Called by DiagramCore after every mutation. */
  emit<T>(type: DomainEventType, payload: T, transactionId?: string): void;

  /** Get all events since a given sequence number. Used by MCP get_events tool. */
  getEventsSince(lastSeq: number): DomainEvent[];

  /** Current sequence number (monotonically increasing). */
  getCurrentSeq(): number;

  /** Clear the event buffer (called on reset_diagram). */
  clear(): void;
}
```

**Key properties**:
- **Monotonic `seq`**: Every event gets an auto-incrementing sequence number, starting at 1. Used by browsers to detect gaps on reconnect.
- **Synchronous emit**: Handlers are called synchronously within `emit()`. This guarantees that the WebSocket message is sent *before* the MCP tool returns to the LLM.
- **Ring buffer**: Stores last 1000 events. Late subscribers (e.g., a reconnecting browser that missed events 50-100) can catch up by requesting events since their last known `seq`.
- **`onAny`**: Used by the WebSocket server for blind broadcast (no need to register per-type).

### 4.3 How DiagramCore Emits Events

Every mutation method in `DiagramCore` emits a typed event after modifying state:

```
addModule(stereotype, x, y):
  1. const node = { id: uuid(), type: "custom", ... }
  2. this.nodes = [...this.nodes, node]
  3. this.events.emit("node_created", { nodeId: node.id, name: node.name, ... })
  4. this.events.emit("graph_changed", { nodeCount: this.nodes.length, ... })
  5. return node

deleteNodes(ids):
  1. const removed = this.nodes.filter(n => ids.includes(n.id))
  2. const removedEdges = this.edges.filter(e => ids.includes(e.source) || ids.includes(e.target))
  3. this.nodes = this.nodes.filter(n => !ids.includes(n.id))
  4. this.edges = this.edges.filter(e => !removedEdges.includes(e))
  5. this.events.emit("node_deleted", { nodeIds: ids, reparentedNodes: [...] })
  6. this.events.emit("edge_deleted", { edgeIds: removedEdges.map(e => e.id) })
  7. this.events.emit("graph_changed", { ... })

connect_nodes(source, target, ...):
  1. validate connection
  2. this.edges = [...this.edges, newEdge]
  3. this.events.emit("edge_created", { edgeId: newEdge.id, source, target, ... })
  4. this.events.emit("graph_changed", { ... })
  5. return newEdge
```

**Transaction-aware emission**: During a transaction, events are buffered in the `TransactionManager` and flushed atomically on `commit()`. On `rollback()`, buffered events are discarded. This means browsers see no events during a transaction — they see all the deltas arrive at once on commit.

### 4.4 Delta Protocol — Why Incremental, Not Snapshots

The WebSocket broadcasts **delta operations**, not full graph snapshots. Rationale:

| Approach | Bandwidth (100 nodes) | Browser work | Correctness |
|----------|----------------------|--------------|-------------|
| Full snapshot every mutation | ~50KB per message | Replace entire arrays; Svelte Flow loses animation state | Trivially correct |
| Incremental deltas | ~200 bytes per message | Targeted push/splice on arrays; Svelte Flow preserves internal state | Requires ordering guarantees |

**Incremental wins** because:
1. A `node_moved` delta is ~80 bytes vs. ~50KB snapshot (625× smaller).
2. Targeted array mutations preserve Svelte Flow's internal animation state (node drag transitions).
3. Browsers can process deltas in <1ms vs. ~10ms for full snapshot reconciliation.
4. Sequence numbers guarantee ordering; the browser can detect gaps and request a snapshot catch-up.

**When snapshots ARE sent**:
- On initial connect (browser needs full state)
- On reconnect with `lastSeenSeq < server.oldestBufferedSeq` (gap too large to catch up via deltas)
- On `diagram_reset` / `diagram_imported` events (state replaced wholesale)

### 4.5 Delta Operation Mapping

Each `DomainEvent` maps to one or more `DeltaOperation`s:

| DomainEvent | DeltaOperation(s) |
|-------------|-------------------|
| `node_created` | `{ op: "node_added", nodeId, data: { type, position, data, ... } }` |
| `node_deleted` | `{ op: "node_removed", nodeId }` × N + `{ op: "edge_removed", edgeId }` × M |
| `node_updated` | `{ op: "node_updated", nodeId, changes: { params?, color?, name? } }` |
| `node_moved` | `{ op: "node_moved", nodeId, position: { x, y } }` |
| `edge_created` | `{ op: "edge_added", edgeId, data: { source, target, ... } }` |
| `edge_deleted` | `{ op: "edge_removed", edgeId }` × N |
| `edge_reconnected` | `{ op: "edge_reconnected", edgeId, changes: { newSource?, newTarget? } }` |
| `selection_changed` | `{ op: "selection_changed", nodeIds, edgeIds }` |
| `diagram_reset` | `{ op: "graph_reset", nodes, edges }` (full replacement) |
| `diagram_imported` | `{ op: "graph_reset", nodes, edges }` (full replacement) |

### 4.6 Browser-Side Sync Client

```typescript
// front-end/src/sync/DiagramSyncClient.ts

import type { Diagram } from "../Diagram.svelte";
import type { WSDeltaMessage, WSSnapshotMessage, DeltaOperation } from "../core/types";

export class DiagramSyncClient {
  private ws: WebSocket | null = null;
  private lastSeenSeq: number = 0;
  private diagram: Diagram;
  private url: string;
  private reconnectDelay: number = 1000;

  constructor(diagram: Diagram, url: string = "ws://localhost:9339") {
    this.diagram = diagram;
    this.url = url;
  }

  connect(): void {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (event) => this.handleMessage(JSON.parse(event.data));
    this.ws.onclose = () => this.scheduleReconnect();
    this.ws.onerror = (err) => console.error("[SyncClient] WebSocket error:", err);
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  private handleMessage(msg: WSSnapshotMessage | WSDeltaMessage): void {
    if (msg.type === "snapshot") {
      this.applySnapshot(msg);
    } else if (msg.type === "delta") {
      this.applyDelta(msg);
    }
  }

  private applySnapshot(msg: WSSnapshotMessage): void {
    // Replace entire arrays (triggers Svelte 5 reactivity)
    this.diagram.nodes = msg.nodes;
    this.diagram.edges = msg.edges;
    this.lastSeenSeq = msg.seq;
  }

  private applyDelta(msg: WSDeltaMessage): void {
    // Sequence check: if we missed events, request full snapshot
    if (msg.seq !== this.lastSeenSeq + 1 && this.lastSeenSeq > 0) {
      console.warn(`[SyncClient] Sequence gap: expected ${this.lastSeenSeq + 1}, got ${msg.seq}. Requesting snapshot.`);
      this.ws?.send(JSON.stringify({ type: "request_snapshot" }));
      return;
    }

    for (const op of msg.operations) {
      this.applyOperation(op);
    }
    this.lastSeenSeq = msg.seq;
  }

  private applyOperation(op: DeltaOperation): void {
    switch (op.op) {
      case "node_added":
        this.diagram.nodes = [...this.diagram.nodes, { id: op.nodeId, ...op.data } as any];
        break;
      case "node_removed":
        this.diagram.nodes = this.diagram.nodes.filter(n => n.id !== op.nodeId);
        break;
      case "node_moved":
        this.diagram.nodes = this.diagram.nodes.map(n =>
          n.id === op.nodeId ? { ...n, position: op.position } : n
        );
        break;
      case "node_updated":
        this.diagram.nodes = this.diagram.nodes.map(n =>
          n.id === op.nodeId ? { ...n, data: { ...n.data, ...op.changes } } : n
        );
        break;
      case "edge_added":
        this.diagram.edges = [...this.diagram.edges, { id: op.edgeId, ...op.data } as any];
        break;
      case "edge_removed":
        this.diagram.edges = this.diagram.edges.filter(e => e.id !== op.edgeId);
        break;
      case "edge_reconnected":
        this.diagram.edges = this.diagram.edges.map(e =>
          e.id === op.edgeId ? { ...e, ...op.changes } : e
        );
        break;
      case "selection_changed":
        this.diagram.nodes = this.diagram.nodes.map(n => ({
          ...n,
          selected: op.nodeIds.includes(n.id),
        }));
        break;
      case "graph_reset":
        this.diagram.nodes = op.nodes;
        this.diagram.edges = op.edges;
        break;
    }
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
      this.connect();
    }, this.reconnectDelay);
  }
}
```

**Integration with the Svelte app** (`FlowCanvas.svelte`):

```svelte
<script lang="ts">
  import { DiagramSyncClient } from "./sync/DiagramSyncClient";

  let syncClient: DiagramSyncClient;

  $effect(() => {
    // Connect on mount, disconnect on unmount
    syncClient = new DiagramSyncClient(diagram);
    syncClient.connect();
    return () => syncClient.disconnect();
  });
</script>
```

### 4.7 Consistency Guarantees

| Guarantee | How |
|-----------|-----|
| **Ordering**: Events are delivered in the order they were emitted | `seq` is monotonic; `EventBus.emit()` is synchronous; WebSocket is TCP (ordered) |
| **No gaps (normal operation)**: Browser receives every event | TCP delivery + `seq` gap detection triggers snapshot request |
| **No duplicates**: Browser ignores events with `seq <= lastSeenSeq` | Client-side dedup |
| **Eventual consistency**: Browser always converges to server state | On reconnect, full snapshot sent; on gap, client requests snapshot |
| **Atomic transactions**: Browser sees all transaction mutations at once | Events buffered during transaction, flushed as single WSDeltaMessage on commit |
| **At-least-once delivery**: No event is silently dropped | WSDeltaMessage carries all operations from the batch; TCP guarantees delivery |

### 4.8 Sequence Diagram — Real-Time Browser Update

```
MCP Tool (LLM)    DiagramCore     EventBus     WS Server     Browser SyncClient    Svelte Flow
    │                  │              │             │               │                   │
    │ create_node(...)  │              │             │               │                   │
    │ ────────────────▶ │              │             │               │                   │
    │                  │ nodes = [...  │             │               │                   │
    │                  │   ...newNode] │             │               │                   │
    │                  │              │             │               │                   │
    │                  │ emit("node_  │             │               │                   │
    │                  │   created",  │             │               │                   │
    │                  │   {nodeId,   │             │               │                   │
    │                  │    name,...})│             │               │                   │
    │                  │ ───────────▶ │             │               │                   │
    │                  │              │ onAny()     │               │                   │
    │                  │              │ handler     │               │                   │
    │                  │              │ calls       │               │                   │
    │                  │              │ ──────────▶ │               │                   │
    │                  │              │             │ WSDeltaMessage│                   │
    │                  │              │             │ {type:"delta", │                  │
    │                  │              │             │  seq:42,       │                  │
    │                  │              │             │  ops:[{op:     │                  │
    │                  │              │             │  "node_added", │                  │
    │                  │              │             │  nodeId, ...}]}│                  │
    │                  │              │             │ ─────────────▶│                   │
    │                  │              │             │               │ applyOperation() │
    │                  │              │             │               │ ───────────────▶│
    │                  │              │             │               │ nodes = [...     │
    │                  │              │             │               │  + newNode]     │
    │                  │              │             │               │                 │ $state.raw triggers
    │                  │              │             │               │                 │ re-render.
    │                  │              │             │               │                 │ New node appears.
    │                  │              │             │               │                 │
    │ ◀── { nodeId } ──│              │             │               │                 │
    │                  │              │             │               │                 │
    │ [LLM can now     │              │             │               │                 │
    │  screenshot via  │              │             │               │                 │
    │  glimpse — node  │              │             │               │                 │
    │  is already      │              │             │               │                 │
    │  visible]        │              │             │               │                 │

    TOTAL LATENCY: <10ms from MCP response to browser update
```

### 4.9 WebSocket Server Configuration

The WebSocket server listens on a configurable port:

```typescript
// mcp-server/src/ws-server.ts

import { WebSocketServer } from "ws";
import type { EventBus } from "@nnmodelling/front-end/core/EventBus";
import type { DiagramCore } from "@nnmodelling/front-end/core/DiagramCore";
import type { WSDeltaMessage, WSSnapshotMessage, DeltaOperation } from "@nnmodelling/front-end/core/types";

export interface WSServerConfig {
  port: number;                  // Default: 9339
  host?: string;                 // Default: "localhost"
  maxClients?: number;           // Default: 10
  pingInterval?: number;         // Default: 30000 (30s)
}

export function createWSServer(
  diagram: DiagramCore,
  eventBus: EventBus,
  config: WSServerConfig
): WebSocketServer;
```

The server:
1. Creates a `WebSocketServer` on `ws://{host}:{port}`.
2. On client connect: sends `WSSnapshotMessage` with full diagram state + current `seq`.
3. Subscribes to `eventBus.onAny()` — converts each `DomainEvent` to `DeltaOperation[]`, packs into `WSDeltaMessage`, broadcasts.
4. On client message `{"type":"request_snapshot"}`: resends full snapshot (used when browser detects a sequence gap).
5. Tracks connected client count and reports it via `ping` tool and `nnmodelling://server/status` resource.
6. Handles graceful shutdown: closes all WebSocket connections on SIGTERM.

---

## 5. MCP Resource Model

MCP resources are **read-only views** of the current diagram state. They allow the LLM to inspect the canvas without calling mutation tools.

### 5.1 Resource URIs

All resources follow the scheme: `nnmodelling://<resource-type>/<path>`

| URI Pattern | Description | MIME Type |
|-------------|-------------|-----------|
| `nnmodelling://diagram/current` | Full diagram state (nodes + edges JSON) | `application/json` |
| `nnmodelling://node/{id}` | Single node by ID | `application/json` |
| `nnmodelling://edge/{id}` | Single edge by ID | `application/json` |
| `nnmodelling://nodes/list` | All node IDs | `application/json` |
| `nnmodelling://edges/list` | All edge IDs | `application/json` |
| `nnmodelling://selection` | Currently selected nodes/edges | `application/json` |
| `nnmodelling://stereotypes` | All available stereotypes | `application/json` |
| `nnmodelling://stereotype/{name}` | Single stereotype definition | `application/json` |
| `nnmodelling://validation` | Latest validation report | `application/json` |
| `nnmodelling://statistics` | Graph statistics (counts, depth, etc.) | `application/json` |
| `nnmodelling://conversion` | Latest NNTree compilation output | `application/json` |
| `nnmodelling://conversion/status` | Latest conversion pipeline status | `application/json` |
| `nnmodelling://history` | Undo/redo stack sizes | `application/json` |
| `nnmodelling://events` | Accumulated event log | `application/json` |

### 5.2 Resource Schemas

#### `nnmodelling://diagram/current`

```json
{
  "nodes": [ /* Svelte Flow Node[] */ ],
  "edges": [ /* Svelte Flow Edge[] */ ],
  "statistics": { /* GraphStatistics */ }
}
```

#### `nnmodelling://node/{id}`

```json
{
  "id": "string",
  "type": "custom | join | subflow",
  "position": { "x": 0, "y": 0 },
  "data": {
    "stereotype": "string",
    "name": "string",
    "params": {},
    "...": "..."
  },
  "parentId": "string | null",
  "incoming": [ /* Edge[] from parents */ ],
  "outgoing": [ /* Edge[] to children */ ]
}
```

#### `nnmodelling://validation`

```json
{
  "valid": false,
  "errors": [
    {
      "code": "CYCLE_DETECTED",
      "message": "Subflow subflow_123 contains a cycle",
      "nodeId": "subflow_123"
    }
  ],
  "warnings": [
    {
      "code": "EMPTY_SUBFLOW",
      "message": "Subflow subflow_456 has no internal nodes",
      "nodeId": "subflow_456"
    }
  ],
  "timestamp": "2026-06-30T12:00:00Z"
}
```

#### `nnmodelling://conversion`

```json
{
  "success": true,
  "root": "node-uuid",
  "nodeCount": 12,
  "subflowCount": 2,
  "lossNodeType": "CrossEntropyLoss",
  "taskType": "classification",
  "outputDir": "/tmp/nnmodelling-output/cfg",
  "configFiles": [
    "cfg/base.yaml",
    "cfg/net/custom_sequence.yaml",
    "cfg/optimizer/adam.yaml",
    "cfg/trainer/default.yaml",
    "cfg/wandb/wandb.yaml",
    "cfg/dataset/dataset.yaml",
    "cfg/early_stopping/default.yaml"
  ],
  "timestamp": "2026-06-30T12:00:00Z"
}
```

---

## 6. MCP Tool Catalogue

Every tool follows a strict contract:
- **Zod-validated inputs** — type-safe at runtime
- **Structured return value** — machine-readable, never plain strings
- **Idempotent where possible** — calling the same tool with the same inputs twice should be safe
- **Atomic** — each tool either fully succeeds or fully fails (no partial state)

### 6.1 Graph Manipulation

#### `create_node`

```
Description: Create a new node on the canvas from a stereotype.

Input:
  stereotype: string           # Required. Name of the stereotype (e.g. "Linear", "ReLU", "Addition").
  position: { x: number, y: number }  # Required. Canvas coordinates.
  config: {
    name?: string              # Custom name (auto-generated if omitted).
    color?: string             # Hex color override.
    width?: number             # Width override.
    height?: number            # Height override.
    params?: Record<string, string>   # Parameter overrides.
    inputsCount?: number       # For join nodes only (default: 2).
  }

Output:
  nodeId: string               # UUID of the created node.
  name: string                 # Assigned name.
  type: "custom" | "join" | "subflow"
  stereotype: string

Errors:
  STEREOTYPE_NOT_FOUND         # stereotype name doesn't exist
  INVALID_POSITION             # x or y is not a number
  INVALID_PARAMETER            # a param name doesn't match the stereotype schema
  PARAMETER_TYPE_MISMATCH      # a param value has wrong type

Notes:
  - The node type is determined by the stereotype category:
    - "Join" → type "join"
    - "Input" → type "custom" with isInput=true
    - Everything else → type "custom"
  - Subflow nodes are created via create_subflow, not this tool.
  - Auto-naming: "{StereotypeName}_{counter}" (counter increments to avoid collisions).
```

#### `create_subflow`

```
Description: Create a new subflow (collapsible container) on the canvas.

Input:
  position: { x: number, y: number }  # Required.
  label?: string                       # Container label (default: "subflow_{timestamp}").

Output:
  nodeId: string               # UUID of the created subflow.
  label: string

Notes:
  - Subflows are initially empty containers.
  - Nodes created inside a subflow must specify parentId in create_node config.
```

#### `delete_nodes`

```
Description: Delete one or more nodes and all their attached edges.

Input:
  nodeIds: string[]            # Required. IDs of nodes to delete.

Output:
  deletedNodeIds: string[]     # Nodes that were deleted.
  deletedEdgeIds: string[]     # Edges that were deleted (attached to deleted nodes).
  reparentedNodes: Array<{     # Nodes that were reparented (orphans of deleted subflows).
    nodeId: string;
    oldParentId: string;
    newParentId: string | null;
  }>

Errors:
  NODE_NOT_FOUND               # One or more nodeIds don't exist

Notes:
  - Deleting a subflow reparents its children up the ancestry chain
    (same behavior as existing Diagram.deleteNodes).
  - Deleting the Input node is allowed but will cause validation errors.
```

#### `duplicate_nodes`

```
Description: Duplicate one or more nodes with their internal connections.
             External connections (to nodes not being duplicated) are severed.

Input:
  nodeIds: string[]            # Required.
  offset?: { x: number, y: number }  # Position offset for duplicates (default: {x:50, y:50}).

Output:
  mapping: Array<{             # Map of old ID → new ID.
    originalId: string;
    duplicateId: string;
  }>
  duplicatedNodeIds: string[]  # All newly created node IDs.
  duplicatedEdgeIds: string[]  # All newly created edge IDs (internal connections only).

Notes:
  - Only edges whose BOTH source and target are in nodeIds are duplicated.
  - Duplicated nodes get new UUIDs and auto-generated names.
```

#### `connect_nodes`

```
Description: Create a directed edge between two nodes.

Input:
  source: string               # Required. Source node ID.
  target: string               # Required. Target node ID.
  sourceHandle?: string        # Source handle ID (default: auto-detect).
  targetHandle?: string        # Target handle ID (default: auto-detect for joins, "in" for modules).

Output:
  edgeId: string               # UUID of the created edge.
  source: string
  target: string
  sourceHandle: string
  targetHandle: string

Errors:
  SOURCE_NOT_FOUND             # source node doesn't exist
  TARGET_NOT_FOUND             # target node doesn't exist
  TARGET_HANDLE_OCCUPIED       # targetHandle already has a connection
  INVALID_CONNECTION           # connection is not semantically valid
  SELF_LOOP                    # source === target
  CYCLE_DETECTED               # connection would create a cycle

Notes:
  - Automatically assigns targetHandle for join nodes (first free "in-N").
  - Source handle defaults to "out".
```

#### `disconnect_nodes`

```
Description: Remove the edge between two specific nodes.

Input:
  source: string               # Required.
  target: string               # Required.
  targetHandle?: string        # If omitted, removes ALL edges from source to target.

Output:
  removedEdgeIds: string[]     # IDs of removed edges.

Errors:
  EDGE_NOT_FOUND               # No edge exists between source and target
```

#### `reconnect_edge`

```
Description: Change the source or target of an existing edge.

Input:
  edgeId: string               # Required.
  newSource?: string           # New source node ID.
  newTarget?: string           # New target node ID.
  newSourceHandle?: string     # New source handle.
  newTargetHandle?: string     # New target handle.

Output:
  edgeId: string               # Same edge ID (edge is updated in-place).
  previous: { source, target, sourceHandle, targetHandle }
  current: { source, target, sourceHandle, targetHandle }

Errors:
  EDGE_NOT_FOUND
  TARGET_HANDLE_OCCUPIED       # new targetHandle conflicts
  CYCLE_DETECTED               # new connection creates a cycle

Notes:
  - At least one of newSource/newTarget must be provided.
```

#### `move_nodes`

```
Description: Set absolute positions for one or more nodes.

Input:
  positions: Array<{
    id: string;
    x: number;
    y: number;
  }>

Output:
  moved: Array<{ id: string; x: number; y: number }>

Errors:
  NODE_NOT_FOUND
```

#### `align_nodes`

```
Description: Align selected nodes along an axis.

Input:
  nodeIds: string[]            # Required.
  axis: "left" | "center" | "right" | "top" | "middle" | "bottom"
  reference?: "first" | "last" | "average" | "min" | "max"  # Default: "average"

Output:
  aligned: Array<{ id: string; x: number; y: number }>
```

#### `distribute_nodes`

```
Description: Distribute selected nodes evenly.

Input:
  nodeIds: string[]            # Required. At least 3 nodes.
  axis: "horizontal" | "vertical"

Output:
  distributed: Array<{ id: string; x: number; y: number }>

Errors:
  INSUFFICIENT_NODES           # Need at least 3 nodes to distribute
```

### 6.2 Parameters

#### `set_parameter`

```
Description: Set a single parameter value on a node.

Input:
  nodeId: string               # Required.
  key: string                  # Required. Parameter name.
  value: string                # Required. String representation of the value.

Output:
  nodeId: string
  key: string
  previousValue: string | null
  currentValue: string

Errors:
  NODE_NOT_FOUND
  PARAMETER_NOT_FOUND          # key doesn't exist in the node's stereotype schema
  PARAMETER_TYPE_MISMATCH      # value cannot be parsed to the expected type

Notes:
  - Values are stored as strings (matching the existing param format).
  - Validation checks that the value is parseable to the stereotype's declared type.
```

#### `update_parameters`

```
Description: Set multiple parameters on a node atomically.

Input:
  nodeId: string               # Required.
  params: Record<string, string>  # Required. Key-value pairs.

Output:
  nodeId: string
  updated: Array<{ key: string; previousValue: string; currentValue: string }>
  unchanged: string[]          # Keys that were already at the specified value

Errors:
  NODE_NOT_FOUND
  PARAMETER_NOT_FOUND
  PARAMETER_TYPE_MISMATCH

Notes:
  - Atomic: if any param is invalid, none are updated.
```

#### `reset_parameters`

```
Description: Reset one or all parameters on a node to their stereotype defaults.

Input:
  nodeId: string               # Required.
  keys?: string[]              # Parameter names to reset. If omitted, reset ALL.

Output:
  nodeId: string
  reset: Array<{ key: string; previousValue: string; defaultValue: string }>
```

#### `query_parameters`

```
Description: Read all parameters of a node with their metadata.

Input:
  nodeId: string | string[]    # Single ID or array of IDs.

Output:
  nodes: Array<{
    nodeId: string;
    name: string;
    stereotype: string;
    params: Array<{
      key: string;
      value: string;
      type: string;
      default: string;
      position?: "top" | "bottom";
      isModified: boolean;    # true if value differs from default
    }>
  }>
```

### 6.3 Selection

#### `select_nodes`

```
Description: Set the selection state of specific nodes.

Input:
  nodeIds: string[]            # Required.
  mode?: "replace" | "add" | "remove"  # Default: "replace"

Output:
  selectedNodeIds: string[]
  selectedEdgeIds: string[]    # Always empty after select_nodes (edges are deselected)

Notes:
  - "replace" clears the current selection and selects only the given nodes.
  - "add" adds nodes to the current selection.
  - "remove" removes nodes from the current selection.
  - Selecting a node deselects all edges.
```

#### `select_all`

```
Description: Select all nodes on the canvas.

Input: (none)

Output:
  selectedNodeIds: string[]
  totalNodes: number
```

#### `clear_selection`

```
Description: Deselect everything.

Input: (none)

Output:
  clearedNodes: number         # How many nodes were deselected.
  clearedEdges: number         # How many edges were deselected.
```

#### `get_selection`

```
Description: Get the current selection state.

Input: (none)

Output:
  nodeIds: string[]
  edgeIds: string[]
  nodes: Array<{               # Full node data for selected nodes.
    id: string;
    type: string;
    name: string;
    stereotype: string;
    position: { x: number; y: number };
  }>
```

### 6.4 Canvas

#### `get_canvas_state`

```
Description: Get the current canvas viewport state (zoom, pan).

Input: (none)

Output:
  zoom: number                 # Current zoom level (1.0 = 100%)
  pan: { x: number; y: number }  # Current pan offset
  viewport: {                  # Computed viewport in flow coordinates
    x: number;
    y: number;
    width: number;
    height: number;
  }
```

#### `fit_view`

```
Description: Fit all nodes into the viewport.

Input:
  padding?: number             # Padding in pixels (default: 0.1 = 10%)
  duration?: number            # Animation duration in ms (default: 0)

Output:
  zoom: number                 # New zoom level after fit
  pan: { x: number; y: number }
```

#### `center_view`

```
Description: Center the view on specific nodes.

Input:
  nodeIds?: string[]           # Nodes to center on. If omitted, center on all nodes.
  zoom?: number                # Target zoom level (default: keep current zoom)

Output:
  zoom: number
  pan: { x: number; y: number }

Notes:
  - This sets the Svelte Flow viewport programmatically.
  - The actual visual result is visible via glimpse screenshots.
```

### 6.5 Validation

#### `validate_graph`

```
Description: Run all validation checks on the current diagram.

Input: (none)

Output: GraphValidationResult (see §3.4)

Checks performed:
  1. Exactly one Input node exists
  2. No cycles in subflow graphs (Kahn's topological sort)
  3. No orphan nodes (unreachable from Input)
  4. All connection targets have free handles
  5. All nodes reference valid stereotypes
  6. All required parameters are filled (not "Undefined")
  7. No empty subflows
  8. Loss nodes must be terminal (no outgoing connections)

Notes:
  - This is the same validation logic invoked by compile_nntree.
  - Calling this explicitly before compilation allows the LLM to fix errors iteratively.
```

#### `validate_connections`

```
Description: Check only connection-related issues.

Input: (none)

Output: GraphValidationResult

Checks performed:
  - Target handle conflicts
  - Self-loops
  - Cycles
  - Orphan detection
```

#### `validate_parameters`

```
Description: Check only parameter-related issues.

Input: (none)

Output: GraphValidationResult

Checks performed:
  - Required parameters filled
  - Parameter type correctness
  - Out-of-range values (where applicable)
```

#### `validate_subflows`

```
Description: Check only subflow-related issues.

Input: (none)

Output: GraphValidationResult

Checks performed:
  - Subflows contain at least one internal node
  - Subflow cycle detection (Kahn's sort)
  - Nested subflow depth limit (configurable, default: 10)
  - Subflow entry node is reachable
```

### 6.6 Compilation & Conversion

#### `compile_nntree`

```
Description: Compile the current diagram into an NNTree.

Input: (none)

Output:
  success: boolean
  nntree: string               # JSON string of the NNTree (same as toJson())
  root: string
  nodeCount: number
  subflowCount: number
  lossNodeType: string | null
  taskType: string | null
  errors: ValidationError[]    # If success=false

Errors:
  COMPILATION_FAILED           # NNTree constructor threw (e.g., no Input node)
  VALIDATION_FAILED            # Pre-compilation validation found issues

Notes:
  - Runs validate_graph() first; if validation fails, compilation is aborted.
  - The NNTree JSON is compatible with convert.py (same format as existing files).
```

#### `export_diagram`

```
Description: Export the current diagram to a JSON file for the browser to load.

Input:
  filePath?: string            # Output path. Default: "./diagram.json"

Output:
  filePath: string             # Absolute path of the written file
  nodeCount: number
  edgeCount: number

Notes:
  - Uses DiagramCore.exportToJson().
  - The browser can load this file via the Load button.
  - The filePath should be accessible by both the MCP server process and the browser.
```

#### `import_diagram`

```
Description: Import a diagram from a JSON file.

Input:
  filePath: string             # Required. Path to a .json file.
  reset?: boolean              # Default: false. If true, replace entire state; if false, merge.

Output:
  nodeCount: number
  edgeCount: number
  stats: GraphStatistics

Notes:
  - Re-hydrates subflow callbacks (identical to Diagram.importFromJson).
  - With reset=true, replaces the entire diagram state.
  - With reset=false, merges nodes/edges into existing state (duplicate IDs are skipped).
```

#### `execute_conversion`

```
Description: Run the full conversion pipeline: compile NNTree → generate Hydra configs.

Input:
  outputDir?: string           # Default: "./cfg"
  numClasses?: number          # For classification tasks
  dataset?: string             # Default: "dataset.mnist.MNISTDataset"
  earlyStopPatience?: number   # Default: 3
  earlyStopMinDelta?: number   # Default: 0.0
  maxEpochs?: number           # Default: 20

Output:
  success: boolean
  outputDir: string            # Absolute path
  taskType: string
  numClasses: number | null
  configFiles: string[]        # List of generated YAML files
  errors: ValidationError[]    # If success=false

Notes:
  - Internally calls compile_nntree(), then spawns: uv run python convert.py <json> <outputDir> [flags]
  - The NNTree JSON is written to a temp file and passed to convert.py.
```

#### `execute_training`

```
Description: Train a model using the generated Hydra configs.

Input:
  configDir: string            # Required. Path to Hydra config directory (from execute_conversion).
  configName?: string          # Default: "base"
  device?: "cpu" | "gpu"       # Default: "cpu"
  maxEpochs?: number           # Override max_epochs from config

Output:
  success: boolean
  checkpointPath: string | null  # Path to saved weights.pt
  metrics: {                    # Final epoch metrics (if available)
    trainLoss?: number;
    valLoss?: number;
    valAccuracy?: number;
  }
  logPath: string              # Path to training log
  duration: number             # Training duration in seconds
  errors: string[]             # If success=false

Notes:
  - Spawns: uv run python main.py --config-path <configDir> --config-name <configName>
  - Training can take minutes. The tool runs synchronously (blocks until complete).
  - Future: async training with status polling (see §15.3).
```

#### `execute_inference`

```
Description: Run inference on a trained model.

Input:
  configDir: string            # Required. Path to Hydra config directory.
  configName?: string          # Default: "base"
  weightsPath: string          # Required. Path to .pt checkpoint.
  outputPath?: string          # Path for predictions JSON.
  imageDir?: string            # Path for visualization images.
  device?: "cpu" | "gpu"       # Default: "cpu"

Output:
  success: boolean
  predictionsPath: string | null
  imageDir: string | null
  sampleCount: number
  metrics: Record<string, number>  # Test metrics
  errors: string[]
```

### 6.7 Inspection

#### `get_graph`

```
Description: Get the full graph structure.

Input:
  includeData?: boolean        # Default: true. Include node.data payloads.

Output:
  nodes: Array<{ id: string; type: string; position: {x,y}; data: object }>
  edges: Array<{ id: string; source: string; target: string; sourceHandle: string; targetHandle: string }>

Notes:
  - This is the canonical way for the LLM to understand the current graph state.
  - Equivalent to reading `nnmodelling://diagram/current`.
```

#### `get_node`

```
Description: Get detailed information about a specific node.

Input:
  nodeId: string               # Required.

Output:
  id: string
  type: string
  stereotype: string
  name: string
  position: { x: number; y: number }
  params: Record<string, { value: string; position?: string }>
  parentId: string | null
  children: string[]           # IDs of child nodes (outgoing edges)
  parents: string[]            # IDs of parent nodes (incoming edges)
  isInput: boolean
  isLoss: boolean

Errors:
  NODE_NOT_FOUND
```

#### `get_edges`

```
Description: Get all edges or filtered edges.

Input:
  source?: string              # Filter by source node ID.
  target?: string              # Filter by target node ID.
  subflowId?: string           # Filter by parent subflow ID.

Output:
  edges: Edge[]

Notes:
  - All filters are optional. If none provided, returns all edges.
  - Filters combine with AND logic.
```

#### `get_subflow`

```
Description: Get the internal structure of a subflow.

Input:
  subflowId: string            # Required.

Output:
  id: string
  label: string
  isCollapsed: boolean
  internalNodes: string[]      # IDs of nodes inside this subflow
  internalEdges: string[]      # IDs of edges inside this subflow
  children: string[]           # Nodes directly contained (parentId === subflowId)
  nestedSubflows: string[]     # Subflows inside this subflow (recursive)

Errors:
  NODE_NOT_FOUND
  NOT_A_SUBFLOW                # nodeId exists but is not a subflow
```

#### `graph_statistics`

```
Description: Get aggregate statistics about the current graph.

Input: (none)

Output: GraphStatistics (see §3.5)

Notes:
  - maxDepth is computed via BFS from the Input node.
  - avgFanOut is the average number of outgoing edges per non-loss node.
  - cycleFree is checked via topological sort on each subflow.
```

#### `list_stereotypes`

```
Description: List all available stereotypes with their categories.

Input:
  category?: "module" | "join" | "subflow" | "input" | "loss"  # Filter by category.

Output:
  stereotypes: Array<{
    name: string;
    category: string;
    pythonClassName: string;
    params: Record<string, { type: string; default: string }>;
  }>
```

### 6.8 Transaction

#### `begin_transaction`

```
Description: Start a transaction. All subsequent mutations are buffered until commit or rollback.

Input:
  label?: string               # Human-readable label for the transaction.

Output:
  transactionId: string        # UUID for this transaction.

Notes:
  - Cannot nest transactions. Calling begin_transaction while one is active returns an error.
  - Events are buffered during a transaction and flushed on commit.
```

#### `commit`

```
Description: Commit the active transaction. All buffered mutations are applied atomically.

Input: (none)

Output:
  transactionId: string
  mutations: Array<{           # Summary of all mutations applied.
    type: string;              # "node_created", "edge_created", "node_deleted", etc.
    summary: string;           # Human-readable description.
  }>
  snapshotCreated: boolean     # Whether an undo snapshot was saved.

Errors:
  NO_ACTIVE_TRANSACTION        # No begin_transaction was called

Notes:
  - After commit, a snapshot is pushed to the undo stack (see §11).
  - Events are flushed: all buffered events are published at once.
```

#### `rollback`

```
Description: Abort the active transaction. All buffered mutations are discarded.

Input: (none)

Output:
  transactionId: string
  discardedMutations: number   # How many mutations were discarded.

Errors:
  NO_ACTIVE_TRANSACTION

Notes:
  - State is restored to the snapshot taken at begin_transaction.
  - The undo stack is NOT modified (the aborted transaction didn't happen).
```

### 6.9 History

#### `undo`

```
Description: Undo the last committed operation or transaction.

Input: (none)

Output:
  undone: string               # Description of what was undone.
  canUndo: boolean             # Whether more undo is possible.
  canRedo: boolean             # Whether redo is now possible.

Errors:
  NOTHING_TO_UNDO              # Undo stack is empty

Notes:
  - Undo restores the diagram snapshot from before the last commit.
  - Undo creates a redo snapshot of the current state.
```

#### `redo`

```
Description: Redo the last undone operation.

Input: (none)

Output:
  redone: string               # Description of what was redone.
  canUndo: boolean
  canRedo: boolean

Errors:
  NOTHING_TO_REDO              # Redo stack is empty
```

#### `get_history_status`

```
Description: Get the current undo/redo stack status.

Input: (none)

Output:
  undoCount: number            # Number of undoable operations.
  redoCount: number            # Number of redoable operations.
  undoStack: Array<{
    description: string;
    timestamp: string;
    nodeCount: number;
    edgeCount: number;
  }>
  maxUndoDepth: number         # Configured limit.
```

### 6.10 Event

#### `get_events`

```
Description: Retrieve accumulated events since last call.

Input:
  since?: string               # ISO timestamp. Only return events after this time.
  types?: string[]             # Filter by event types.
  clear?: boolean              # Default: true. Clear the event buffer after returning.

Output:
  events: MCPEvent[]           # See §10.
  count: number
  remaining: number            # Events remaining in buffer (if clear=false)
  latestTimestamp: string      # ISO timestamp of the last event
```

### 6.11 Lifecycle

#### `reset_diagram`

```
Description: Reset the diagram to a blank state (only the Input node).

Input: (none)

Output:
  nodeCount: number            # Should be 1 (the Input node).
  edgeCount: number            # Should be 0.

Notes:
  - Clears undo/redo stacks.
  - Clears event buffer.
  - Starts a fresh DiagramCore instance.
```

#### `ping`

```
Description: Health check. Returns server status.

Input: (none)

Output:
  status: "ok"
  uptime: number               # Seconds since server start.
  diagramNodeCount: number
  diagramEdgeCount: number
  activeTransaction: boolean
```

---

## 7. API Naming Conventions

### 7.1 Tool Naming

All MCP tools follow a consistent naming scheme:

| Pattern | Examples | Meaning |
|---------|----------|---------|
| `verb_noun` | `create_node`, `delete_nodes`, `move_nodes` | Mutating operation |
| `verb_adjective_noun` | `begin_transaction`, `clear_selection` | Mutating with qualifier |
| `get_noun` | `get_node`, `get_graph`, `get_selection` | Read operation |
| `list_nouns` | `list_stereotypes` | List all of a resource |
| `validate_noun` | `validate_graph`, `validate_parameters` | Validation check |
| `compile_noun` | `compile_nntree` | Compilation operation |
| `execute_noun` | `execute_conversion`, `execute_training` | External pipeline |
| `export_noun` / `import_noun` | `export_diagram`, `import_diagram` | Serialization |

**Principles**:
- Verbs are always imperative.
- Nouns are singular when operating on one, plural when operating on many.
- "get_" prefix for queries, "list_" for enumerations.
- No abbreviations (except well-known: `nntree`, `id`, `json`).
- snake_case throughout (MCP convention, consistent with Python side).

### 7.2 Resource Naming

| Pattern | Examples |
|---------|----------|
| `nnmodelling://resource` | `nnmodelling://diagram`, `nnmodelling://selection` |
| `nnmodelling://resource/{id}` | `nnmodelling://node/{id}` |
| `nnmodelling://resource/sub` | `nnmodelling://conversion/status` |
| `nnmodelling://collection/list` | `nnmodelling://nodes/list` |

### 7.3 Parameter Naming

- **camelCase** for all tool parameters and return values (JavaScript/TypeScript convention).
- **snake_case** for MCP tool names and resource URIs (MCP convention).
- Structured objects for complex inputs/outputs (never comma-separated strings).
- All IDs are strings (UUIDs).
- Boolean parameters default to `false` unless specified otherwise.

### 7.4 Error Code Naming

- `SCREAMING_SNAKE_CASE`
- `NOUN_REASON` pattern: `NODE_NOT_FOUND`, `CYCLE_DETECTED`, `TARGET_HANDLE_OCCUPIED`
- Errors are domain-specific, not HTTP-based (there is no HTTP layer in MCP).

---

## 8. Sequence Diagrams

### 8.1 Create Node + Connect Flow

```
LLM Agent                    MCP Server                   DiagramCore
    │                            │                             │
    │  list_stereotypes()        │                             │
    │ ─────────────────────────▶ │                             │
    │ ◀───────────────────────── │                             │
    │  [Linear, ReLU, Tanh, ...] │                             │
    │                            │                             │
    │  create_node(              │                             │
    │    "Linear",               │                             │
    │    {x: 100, y: 50},        │                             │
    │    {params: {in_features: "784", out_features: "128"}}   │
    │  )                         │                             │
    │ ─────────────────────────▶ │                             │
    │                            │  addModule(stereotype, ...) │
    │                            │ ──────────────────────────▶ │
    │                            │ ◀───── { nodeId, name } ─── │
    │                            │                             │
    │                            │  emit("node_created", ...)  │
    │ ◀───────────────────────── │                             │
    │  { nodeId: "uuid-1",       │                             │
    │    name: "Linear_0" }      │                             │
    │                            │                             │
    │  create_node(              │                             │
    │    "ReLU",                 │                             │
    │    {x: 100, y: 150}        │                             │
    │  )                         │                             │
    │ ─────────────────────────▶ │                             │
    │                            │  addModule("ReLU", ...)     │
    │ ◀───────────────────────── │                             │
    │  { nodeId: "uuid-2",       │                             │
    │    name: "ReLU_0" }        │                             │
    │                            │                             │
    │  connect_nodes(            │                             │
    │    source: "uuid-1",       │                             │
    │    target: "uuid-2"        │                             │
    │  )                         │                             │
    │ ─────────────────────────▶ │                             │
    │                            │  addEdge("uuid-1","uuid-2") │
    │ ◀───────────────────────── │                             │
    │  { edgeId: "edge-uuid" }   │                             │
    │                            │                             │
```

### 8.2 Transaction Flow

```
LLM Agent                    MCP Server              Transaction Mgr
    │                            │                          │
    │  begin_transaction(        │                          │
    │    "Build MNIST classifier"│                          │
    │  )                         │                          │
    │ ─────────────────────────▶ │                          │
    │                            │  snapshot = diagram      │
    │                            │  .getSnapshot()          │
    │ ◀───────────────────────── │                          │
    │  { transactionId: "t1" }   │                          │
    │                            │                          │
    │  ── Multiple mutations ──  │                          │
    │  create_node("Linear", ...)│                          │
    │ ─────────────────────────▶ │                          │
    │                            │  buffer mutation         │
    │                            │  (do NOT modify diagram) │
    │ ◀───────────────────────── │                          │
    │  create_node("ReLU", ...)  │                          │
    │ ─────────────────────────▶ │                          │
    │  connect_nodes(...)        │                          │
    │ ─────────────────────────▶ │                          │
    │  set_parameter(...)        │                          │
    │ ─────────────────────────▶ │                          │
    │                            │                          │
    │  ── Validate before commit │                          │
    │  validate_graph()          │                          │
    │ ─────────────────────────▶ │                          │
    │                            │  apply buffered          │
    │                            │  mutations to temp state │
    │                            │  run validation          │
    │ ◀───────────────────────── │                          │
    │  { valid: true }           │                          │
    │                            │                          │
    │  commit()                  │                          │
    │ ─────────────────────────▶ │                          │
    │                            │  apply all mutations     │
    │                            │  save undo snapshot      │
    │                            │  flush events            │
    │ ◀───────────────────────── │                          │
    │  { mutations: [...],       │                          │
    │    snapshotCreated: true } │                          │
    │                            │                          │
```

### 8.3 Compile + Train Flow

```
LLM Agent                    MCP Server              Python Pipeline
    │                            │                          │
    │  compile_nntree()          │                          │
    │ ─────────────────────────▶ │                          │
    │                            │  new NNTree(diagram)     │
    │                            │  nntree.toJson()         │
    │ ◀───────────────────────── │                          │
    │  { success: true,          │                          │
    │    nntree: "...",          │                          │
    │    taskType: "classif." }  │                          │
    │                            │                          │
    │  execute_conversion(       │                          │
    │    outputDir: "./cfg",     │                          │
    │    numClasses: 10          │                          │
    │  )                         │                          │
    │ ─────────────────────────▶ │                          │
    │                            │  write NNTree JSON       │
    │                            │  to temp file            │
    │                            │                          │
    │                            │  spawn: uv run python    │
    │                            │  convert.py ... ────────▶│
    │                            │                          │ compile
    │                            │                          │ generate
    │                            │                          │ YAMLs
    │                            │ ◀────── exit code 0 ─────│
    │ ◀───────────────────────── │                          │
    │  { success: true,          │                          │
    │    configFiles: [...] }    │                          │
    │                            │                          │
    │  execute_training(         │                          │
    │    configDir: "./cfg",     │                          │
    │    maxEpochs: 1            │                          │
    │  )                         │                          │
    │ ─────────────────────────▶ │                          │
    │                            │  spawn: uv run python    │
    │                            │  main.py ... ───────────▶│
    │                            │                          │ train
    │                            │                          │ (may take
    │                            │                          │  minutes)
    │                            │ ◀────── exit code 0 ─────│
    │ ◀───────────────────────── │                          │
    │  { success: true,          │                          │
    │    checkpointPath: "...",  │                          │
    │    metrics: {...} }        │                          │
    │                            │                          │
```

### 8.4 LLM + glimpse Real-Time Visual Verification Loop

```
LLM Agent               MCP Server            EventBus/WS        Browser (glimpse)
    │                        │                      │                    │
    │  ── Build graph ──     │                      │                    │
    │  create_node(           │                      │                    │
    │    "Linear",            │                      │                    │
    │    {x: 100, y: 50},     │                      │                    │
    │    {params: {...}}      │                      │                    │
    │  )                      │                      │                    │
    │ ──────────────────────▶ │                      │                    │
    │                        │ nodes = [...+new]     │                    │
    │                        │ emit("node_created")  │                    │
    │                        │ ─────────────────────▶│                    │
    │                        │                      │ WSDeltaMessage     │
    │                        │                      │ ─────────────────▶ │
    │                        │                      │                    │ applyOperation()
    │                        │                      │                    │ → node appears
    │ ◀── { nodeId: "n1" } ──│                      │                    │
    │                        │                      │                    │
    │  ── Repeat for more    │                      │                    │
    │     nodes + edges ──   │                      │                    │
    │                        │                      │                    │
    │  ── Browser is ALREADY │                      │                    │
    │     up to date ──      │                      │                    │
    │                        │                      │                    │
    │  [glimpse] screenshot( │                      │                    │
    │    selector: ".canvas" │                      │                    │
    │  )                     │                      │                    │
    │ ─────────────────────────────────────────────────────────────────▶ │
    │ ◀─────────── PNG image ─────────────────────────────────────────── │
    │                        │                      │                    │
    │  [Analyze] "Linear_0   │                      │                    │
    │   is too far right."   │                      │                    │
    │                        │                      │                    │
    │  move_nodes([          │                      │                    │
    │    {id:"n1",           │                      │                    │
    │     x:100, y:50}       │                      │                    │
    │  ])                    │                      │                    │
    │ ──────────────────────▶ │                      │                    │
    │                        │ emit("node_moved")    │                    │
    │                        │ ─────────────────────▶│                    │
    │                        │                      │ WSDeltaMessage     │
    │                        │                      │ {op:"node_moved"}  │
    │                        │                      │ ─────────────────▶ │
    │                        │                      │                    │ → node animates
    │ ◀── { moved: [...] } ──│                      │                    │
    │                        │                      │                    │
    │  [glimpse] smart_diff()│                      │                    │
    │ ─────────────────────────────────────────────────────────────────▶ │
    │ ◀──────── diff image ───────────────────────────────────────────── │
    │                        │                      │                    │

    KEY INSIGHT: No export_diagram / import_diagram / file exchange / Load button.
    Browser updates are real-time (<10ms), triggered automatically by MCP mutations.
    The LLM goes directly from "create_node" → "screenshot" — zero manual steps.
```

---

## 9. Transaction Model

### 9.1 Why Transactions for LLM Agents

LLM agents build graphs incrementally. Without transactions:

1. **Partial failure leaves broken state**: If an agent creates 5 nodes and the 6th fails, the diagram is in an inconsistent state. The agent must manually undo each of the 5 successful nodes.

2. **Validation-incubation mismatch**: The agent may want to try a graph topology, validate it, and rollback if it's invalid — without dirtying the undo history.

3. **Batch atomicity**: Complex graph edits (e.g., "replace this subgraph with that one") require multiple coordinated mutations. If one mutation fails, the entire group should not have been applied.

4. **Clean undo**: A committed transaction becomes a single undoable unit. Without transactions, the agent "undo" would have to undo each individual mutation one by one.

5. **Preview semantics**: The agent can tentatively apply changes, inspect via `get_graph()` or `validate_graph()`, and decide whether to commit or rollback — all without affecting the undo stack.

### 9.2 Transaction Lifecycle

```
   IDLE
    │
    │  begin_transaction(label)
    ▼
  ACTIVE ──────────────────────────────────────┐
    │                                            │
    │  create_node(...)   ──▶ buffered          │
    │  connect_nodes(...) ──▶ buffered          │
    │  set_parameter(...) ──▶ buffered          │
    │  validate_graph()   ──▶ runs on preview   │
    │  get_graph()        ──▶ returns preview   │
    │                                            │
    ├── commit() ──▶ apply all mutations        │
    │                save undo snapshot          │
    │                flush events                │
    │                return summary              │
    │                                            │
    └── rollback() ──▶ discard all              │
                       restore snapshot          │
                       return summary            │
    │
    ▼
   IDLE
```

### 9.3 Preview Mode

During an active transaction, **read operations** operate on a **preview** of the state:

- `get_graph()` returns the diagram as if all buffered mutations were applied.
- `validate_graph()` validates the preview state.
- `compile_nntree()` compiles the preview state.
- `get_node()` returns preview node data.

This allows the LLM to verify correctness before committing.

**Read operations during a transaction do NOT mutate the preview** — they only read it.

### 9.4 Transaction Constraints

| Constraint | Rationale |
|-----------|-----------|
| **No nesting** | Simplifies implementation; multiphase work can use consecutive transactions. |
| **Mutations only buffered, not applied** | The real DiagramCore is untouched until commit. This makes rollback trivial (just discard the buffer). |
| **Events buffered** | Events are only emitted on commit. This avoids "false alarm" events that get rolled back. |
| **Undo snapshot only on commit** | Rollbacks don't create undo entries (they never happened). |
| **Preview via shallow clone** | The preview state is a shallow clone of DiagramCore, avoiding expensive deep copies. |

### 9.5 Implementation Outline

```
TransactionManager {
  activeTransaction: Transaction | null;
  diagram: DiagramCore;

  begin(label: string): Transaction;
  commit(): CommitResult;
  rollback(): RollbackResult;

  // Called by tool handlers:
  executeWithinTransaction(mutation: () => void): void;
  // If no active transaction: execute immediately.
  // If active transaction: buffer the mutation.
}
```

---

## 10. Undo / Redo Model

### 10.1 Snapshot-Based Undo

The undo/redo system uses **complete diagram snapshots** — not command objects. Rationale:

- **Simplicity**: A snapshot is just `{ nodes: Node[], edges: Edge[] }`. No need to implement `invert()` for every operation.
- **Memory**: A typical diagram has < 100 nodes, each < 1KB. Snapshots are < 100KB each. With a 50-entry undo stack, memory usage is < 5MB.
- **Correctness**: Reverting a snapshot is trivially correct (restore exact state). Command-based undo requires every command to have a perfect inverse, which is error-prone.
- **Performance**: Cloning 100 nodes × 1KB = 100μs. Negligible compared to MCP round-trip times.

### 10.2 Data Structure

```typescript
class HistoryManager {
  private undoStack: DiagramSnapshot[] = [];
  private redoStack: DiagramSnapshot[] = [];
  private maxDepth: number = 50;

  // Called after each commit (or non-transactional mutation):
  pushSnapshot(description: string, snapshot: DiagramCoreSnapshot): void {
    this.undoStack.push({
      ...snapshot,
      timestamp: Date.now(),
      description,
    });
    this.redoStack = [];  // New action invalidates redo
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();  // Drop oldest
    }
  }

  undo(current: DiagramCore): UndoResult {
    if (this.undoStack.length === 0) throw new NothingToUndoError();
    // Save current state to redo stack
    this.redoStack.push(this.createSnapshot(current, "redo point"));
    // Pop and restore
    const snapshot = this.undoStack.pop()!;
    current.restoreSnapshot(snapshot);
    return { undone: snapshot.description, canUndo: this.undoStack.length > 0, canRedo: true };
  }

  redo(current: DiagramCore): RedoResult {
    if (this.redoStack.length === 0) throw new NothingToRedoError();
    this.undoStack.push(this.createSnapshot(current, "undo point"));
    const snapshot = this.redoStack.pop()!;
    current.restoreSnapshot(snapshot);
    return { redone: snapshot.description, canUndo: true, canRedo: this.redoStack.length > 0 };
  }
}
```

### 10.3 Interaction with Transactions

```
Single mutation (no transaction):
  mutation → push undo snapshot
  Transaction = 1 undo entry

Transaction (multiple mutations):
  begin → buffer M1, M2, M3 → commit → apply all → push undo snapshot
  Transaction = 1 undo entry (covers all 3 mutations)

Rollback:
  begin → buffer M1, M2 → rollback → discard → no undo entry
  Undo stack unchanged (the aborted transaction never happened)

Undo after transaction:
  undo → restores state from BEFORE the transaction
  All mutations in the transaction are reverted as one unit

Redo after undo of transaction:
  redo → restores state from AFTER the transaction
  All mutations are re-applied as one unit
```

### 10.4 When Snapshots Are Pushed

| Scenario | Snapshot Pushed? | Description |
|----------|-----------------|-------------|
| `create_node` (no transaction) | Yes | "Created Linear_0" |
| `delete_nodes` (no transaction) | Yes | "Deleted 3 nodes" |
| `connect_nodes` (no transaction) | Yes | "Connected Linear_0 → ReLU_0" |
| `commit()` after transaction | Yes | "Built MNIST classifier (5 mutations)" |
| `rollback()` | No | Transaction never happened |
| `undo()` | No (pop, don't push) | Undo consumes from undo stack |
| `redo()` | No (pop, don't push) | Redo consumes from redo stack |
| `reset_diagram()` | Stack cleared | Fresh start |
| `import_diagram()` | Yes (if reset=true) | "Imported diagram from file" |

---

## 11. Event Model

### 11.1 Dual-Consumer Event Architecture

The `EventBus` (see §4.2) serves **two consumers** simultaneously:

| Consumer | Transport | Purpose | Granularity |
|----------|-----------|---------|-------------|
| **WebSocket Server** | `ws://` | Real-time browser UI sync | `DomainEvent` → `DeltaOperation[]` → `WSDeltaMessage` broadcast per mutation |
| **MCP Event Polling** | `get_events()` tool | LLM agent audit/verification | `DomainEvent[]` returned on demand with cursor-based polling |

Both consumers subscribe to the **same `EventBus`** — there is no duplication of event emission logic.

### 11.2 Event Types

```typescript
type MCPEventType =
  | "node_created"
  | "node_deleted"
  | "node_updated"
  | "node_moved"
  | "edge_created"
  | "edge_deleted"
  | "edge_reconnected"
  | "subflow_toggled"
  | "selection_changed"
  | "graph_changed"          // Catch-all: fires after any structural change
  | "transaction_began"
  | "transaction_committed"
  | "transaction_rolled_back"
  | "validation_completed"
  | "validation_failed"
  | "compilation_completed"
  | "compilation_failed"
  | "conversion_completed"
  | "conversion_failed"
  | "training_completed"
  | "training_failed"
  | "inference_completed"
  | "inference_failed"
  | "diagram_imported"
  | "diagram_exported"
  | "undo_performed"
  | "redo_performed";

interface MCPEvent {
  type: MCPEventType;
  timestamp: string;          // ISO 8601
  transactionId?: string;     // Set if emitted during a transaction
  payload: Record<string, unknown>;  // Event-specific data
}
```

### 11.3 Event-Specific Payloads

| Event Type | Payload |
|-----------|---------|
| `node_created` | `{ nodeId, name, type, stereotype, position }` |
| `node_deleted` | `{ nodeIds, reparentedNodes }` |
| `edge_created` | `{ edgeId, source, target, sourceHandle, targetHandle }` |
| `edge_deleted` | `{ edgeIds }` |
| `graph_changed` | `{ nodeCount, edgeCount }` |
| `validation_completed` | `{ valid, errorCount, warningCount }` |
| `validation_failed` | `{ errors }` |
| `compilation_completed` | `{ root, nodeCount, taskType }` |
| `training_completed` | `{ metrics, checkpointPath, duration }` |

### 11.4 Polling vs Push — Two Audiences

**For the LLM agent (MCP)**: **Polling only.** The MCP protocol is request/response over stdio; server-initiated push is not supported. The `get_events()` tool provides cursor-based polling (see §6.10).

**For the browser UI (WebSocket)**: **Push (broadcast).** Every `DomainEvent` is converted to a `WSDeltaMessage` and pushed to all connected browsers in real time. This is the primary synchronization mechanism — the browser does not poll.

**Event buffering during transactions**:
- Events are buffered by the `TransactionManager` during an active transaction.
- On `commit()`: all buffered events are flushed to the EventBus at once. The WebSocket server receives them as a batch and sends a single `WSDeltaMessage` with multiple operations. The MCP polling buffer receives them as individual events.
- On `rollback()`: buffered events are discarded — neither consumer sees them.

### 11.5 Event Consumption by LLM Agents

Events are not consumed by human users — they are consumed by the LLM agent itself. The agent uses events for:

1. **Verification**: After `create_node(...)`, the agent can check that a `node_created` event was emitted with the expected nodeId.
2. **Debugging**: After `validate_graph()`, a `validation_failed` event contains the error details.
3. **Progress tracking**: During `execute_training(...)`, the agent can poll for progress events (future enhancement).
4. **Audit trail**: Events provide a complete history of diagram mutations for the agent to reason about.

### 11.6 Example Event Flow

```
Time  Action                          Events Emitted
────  ──────────────────────────────  ──────────────────────────
T1    create_node("Linear", ...)      node_created, graph_changed
T2    create_node("ReLU", ...)        node_created, graph_changed
T3    connect_nodes(Lin→ReLU)         edge_created, graph_changed
T4    validate_graph()                validation_completed
T5    compile_nntree()                compilation_completed
T6    undo()                          graph_changed, undo_performed
```

---

## 12. Error Model

### 12.1 Error Hierarchy

```
MCPServerError (base)
├── ValidationError
│   ├── StereotypeNotFoundError
│   ├── NodeNotFoundError
│   ├── EdgeNotFoundError
│   ├── ParameterNotFoundError
│   ├── ParameterTypeMismatchError
│   ├── InvalidConnectionError
│   ├── TargetHandleOccupiedError
│   ├── SelfLoopError
│   ├── CycleDetectedError
│   ├── InvalidPositionError
│   ├── InvalidSubflowError
│   ├── EmptySubflowError
│   ├── MissingInputNodeError
│   ├── OrphanNodeError
│   └── MissingRequiredParameterError
├── TransactionError
│   ├── NoActiveTransactionError
│   ├── TransactionAlreadyActiveError
│   └── TransactionCommitError
├── HistoryError
│   ├── NothingToUndoError
│   └── NothingToRedoError
├── CompilationError
│   └── CompilationFailedError
├── PipelineError
│   ├── ConversionFailedError
│   ├── TrainingFailedError
│   └── InferenceFailedError
├── SerializationError
│   ├── ImportFailedError
│   └── ExportFailedError
└── InternalError
    └── UnexpectedStateError
```

### 12.2 Error Wire Format

All errors returned by MCP tools follow this structure:

```json
{
  "error": {
    "code": "NODE_NOT_FOUND",
    "message": "Node with ID 'uuid-1234' does not exist",
    "details": {
      "nodeId": "uuid-1234",
      "requestedAt": "2026-06-30T12:00:00Z"
    }
  }
}
```

Each error has:
- **`code`**: Machine-readable, stable, documented. Used by the LLM for branching logic ("if NODE_NOT_FOUND, try creating it first").
- **`message`**: Human-readable, may change between versions. Provides context.
- **`details`**: Structured supplementary data (affected IDs, timestamps, etc.). Type-safe per error code.

### 12.3 Error Handling by LLM Agents

LLM agents should handle errors in a structured way:

```
Plan → Execute → On error:
  ├── NODE_NOT_FOUND → try creating the node, then retry connection
  ├── TARGET_HANDLE_OCCUPIED → disconnect existing edge, then retry
  ├── CYCLE_DETECTED → identify the cycle, remove the problematic edge
  ├── PARAMETER_TYPE_MISMATCH → adjust value format, retry
  ├── VALIDATION_FAILED → iterate: fix issue → validate → repeat
  └── CONVERSION_FAILED → inspect error details, fix NNTree, recompile
```

### 12.4 Tool-Level vs Domain-Level Errors

MCP tools must NEVER return generic errors like `"Something went wrong"`. Every error has:
- A specific code from the error hierarchy
- Context about what went wrong and where
- Enough information for the LLM to formulate a corrective action

If an unexpected internal error occurs (bug in the server), it returns `INTERNAL_ERROR` with a unique incident ID for debugging.

---

## 13. LLM Interaction Flow with glimpse

### 13.1 The Complete Loop (Real-Time Sync)

```
1. PERCEIVE (glimpse)
   │  screenshot of current canvas state
   │  [Browser auto-updates from WebSocket — always current]
   │
   ▼
2. PLAN (LLM reasoning)
   │  "I need a Linear→ReLU→Linear→CrossEntropyLoss classifier"
   │
   ▼
3. MANIPULATE (nnmodelling MCP)
   │  begin_transaction("MNIST classifier")
   │  create_node("Linear", {...})  ×2
   │  create_node("ReLU", {...})
   │  create_node("CrossEntropyLoss", {...})
   │  connect_nodes(...)  ×3
   │  validate_graph()
   │  commit()
   │  [Browser updates in real time as each node/edge is created,
   │   or all at once on commit if within a transaction]
   │
   ▼
4. VERIFY (glimpse)
   │  screenshot of canvas — nodes are ALREADY there
   │  No Load button. No file exchange. Instant visual feedback.
   │
   ▼
5. COMPILE (nnmodelling MCP)
   │  compile_nntree() → JSON
   │  execute_conversion() → Hydra YAML
   │
   ▼
6. TRAIN (nnmodelling MCP)
   │  execute_training(maxEpochs=5)
   │  Wait for results
   │
   ▼
7. ITERATE
   │  "Val accuracy 92%. Let me add Dropout."
   │  create_node("Dropout", ...) → browser updates → screenshot → next edit
   │
   └──▶ Go to step 1
```

### 13.2 Complete Interaction Example (Real-Time Sync)

**Task**: Build an MNIST classifier with Linear(784→128) → ReLU → Dropout(0.3) → Linear(128→10) → CrossEntropyLoss

```
────── STEP 1: Perceive (glimpse) ──────

glimpse.screenshot(selector=".flow-canvas")
→ Returns: image showing the default Input node at center
→ Browser is connected via WebSocket; canvas reflects server state

────── STEP 2: Plan (LLM) ──────

LLM: "Current state has an Input node (id visible in screenshot).
      I need to add:
      Linear_0 (in_features=784, out_features=128) connected to Input
      ReLU_0 connected to Linear_0
      Dropout_0 (p=0.3) connected to ReLU_0
      Linear_1 (in_features=128, out_features=10) connected to Dropout_0
      CrossEntropyLoss connected to Linear_1
      Then validate, compile, and do a quick training smoke test."

────── STEP 3: Manipulate (nnmodelling MCP) ──────

nnmodelling.begin_transaction("Build MNIST classifier")

// Note: The LLM already knows the Input node ID from get_graph()
// or from reading nnmodelling://diagram/current resource
nnmodelling.get_graph({ includeData: false })
→ Input node has id: "input-1"

nnmodelling.create_node(
  stereotype: "Linear",
  position: { x: 200, y: 150 },
  config: { params: { in_features: "784", out_features: "128" } }
)
→ { nodeId: "n1", name: "Linear_0" }
→ [Browser: Linear_0 appears on canvas instantly via WebSocket delta]

nnmodelling.create_node(
  stereotype: "ReLU",
  position: { x: 200, y: 250 }
)
→ { nodeId: "n2", name: "ReLU_0" }
→ [Browser: ReLU_0 appears]

// ... create remaining nodes (Dropout, Linear_1, CrossEntropyLoss) ...
// [Browser: all nodes appear as they're created]

nnmodelling.connect_nodes(source: "input-1", target: "n1")
nnmodelling.connect_nodes(source: "n1", target: "n2")
nnmodelling.connect_nodes(source: "n2", target: "n3")
nnmodelling.connect_nodes(source: "n3", target: "n4")
nnmodelling.connect_nodes(source: "n4", target: "n6")
→ [Browser: edges appear as they're created]

// Validate before committing
nnmodelling.validate_graph()
→ { valid: true, errors: [], warnings: [] }

nnmodelling.commit()
→ { mutations: 10, snapshotCreated: true }
→ [Browser: all transaction mutations visible (they were already streaming
   but now the transaction is finalized)]

────── STEP 4: Verify (glimpse) ──────

// Browser is already up to date — no Load button, no file exchange!
glimpse.screenshot(selector=".flow-canvas")
→ Returns: image showing 6 nodes in a vertical chain, all connected
→ LLM: "All nodes positioned correctly, connections look right"

────── STEP 5: Compile (nnmodelling MCP) ──────

nnmodelling.compile_nntree()
→ { success: true, taskType: "classification", lossNodeType: "CrossEntropyLoss" }

nnmodelling.execute_conversion(outputDir: "./cfg", numClasses: 10)
→ { success: true, configFiles: [...] }

────── STEP 6: Train (nnmodelling MCP) ──────

nnmodelling.execute_training(configDir: "./cfg", maxEpochs: 1, device: "cpu")
→ { success: true, metrics: { valAccuracy: 0.87 }, duration: 45.3 }

────── STEP 7: Iterate ──────

LLM: "87% accuracy after 1 epoch. Let me add BatchNorm1d after Linear_0."

nnmodelling.create_node("BatchNorm1d", {x: 200, y: 200}, {params: {num_features: "128"}})
→ [Browser: BatchNorm1d appears on canvas in <10ms]

// ... reconnect edges ...

glimpse.screenshot(selector=".flow-canvas")
→ LLM: "BatchNorm inserted. Retraining..."

────── END OF INTERACTION ──────

KEY DIFFERENCE FROM FILE-BASED SYNC:
  - No export_diagram() calls
  - No Load button clicks
  - No file system round-trips
  - Browser updates are automatic and instant
  - The LLM's edit→verify loop is limited only by glimpse screenshot latency,
    not by manual file exchange steps
```

---

## 14. Extensibility

### 14.1 Copy/Paste

A copy/paste system would build on `duplicate_nodes`:

```
copy_nodes(nodeIds: string[]): string[]  
  → Stores node data in an internal clipboard

paste_nodes(position: { x: number, y: number }): PasteResult
  → Creates duplicates at the given position, offsetting them from clipboard coords

cut_nodes(nodeIds: string[]): string[]
  → copy_nodes + delete_nodes
```

The clipboard is a server-side in-memory buffer (per session). Future: cross-session clipboard via file serialization.

### 14.2 Templates

Templates are pre-configured subgraphs saved as named presets:

```
save_template(name: string, nodeIds: string[]): void
  → Saves the selected subgraph as a named template in ~/.nnmodelling/templates/

load_template(name: string, position: { x: number, y: number }): PasteResult
  → Inserts the template at the given position with new UUIDs

list_templates(): Template[]
  → Lists available templates
```

Templates can be shared across sessions and users. Backward compatible: the tool catalogue already has `create_*` for building from scratch; templates add a convenience layer without changing the core API.

### 14.3 Macros

Macros are recorded sequences of MCP operations:

```
begin_macro_recording(name: string): void
  → Start recording. All MCP mutations are captured as a macro script.

end_macro_recording(): Macro
  → Stop recording and save the macro.

play_macro(name: string): MacroResult
  → Execute the recorded sequence.

list_macros(): Macro[]
```

Macro scripts are stored as JSON arrays of MCP tool calls, making them:
- Shareable (just JSON files)
- Version-independent (the tool API is the stable interface)
- Debuggable (the LLM can inspect them as regular JSON)

### 14.4 Auto-Layout

Auto-layout would add layout algorithms that operate on the current graph:

```
auto_layout(algorithm: "dagre" | "force" | "grid", options?: LayoutOptions): LayoutResult
  → Computes new positions and calls move_nodes internally.

suggest_layout(nodeIds?: string[]): LayoutSuggestion[]
  → Returns suggested positions without applying them (preview).
```

Layout algorithms are non-destructive (they only change positions, not topology), making them safe to apply at any time.

### 14.5 Graph Rewriting

Graph rewriting applies pattern-matching transformations:

```
apply_transform(transform: "fuse_linear_relu" | "insert_batchnorm" | "add_skip_connection" | string, target: string | string[]): TransformResult
  → Applies a named transformation to the specified node(s).
```

Transforms are defined as composable rules:
1. **Match pattern**: Find subgraphs matching a structural pattern.
2. **Transform**: Replace the matched subgraph with a different subgraph.
3. **Validate**: Check the result is valid.

This is a future capability. The tool name space reserves `apply_transform` and `list_transforms`.

### 14.6 AI-Assisted Graph Generation

The MCP server could host a local LLM (or call an external one) for graph generation:

```
generate_graph(prompt: string, options?: { style: string }): GenerateResult
  → Uses an LLM to generate a graph topology from a natural language description.

suggest_completion(nodeId: string): CompletionResult
  → Suggests what node to connect next (based on common patterns).

suggest_hyperparameters(nodeId: string): ParamSuggestion[]
  → Suggests parameter values for a node (e.g., "out_features should be power of 2").
```

This is speculative. The MCP tool names `generate_graph` and `suggest_*` are reserved for this purpose.

### 14.7 Collaborative Editing

Multiple clients (multiple LLM agents, or human + agent) editing the same diagram:

The MVP already includes a WebSocket server. For multi-user editing, this naturally extends to:

1. **MVP (single browser)**: The WebSocket server already broadcasts state changes to connected clients. The `DiagramSyncClient` in the browser receives and applies deltas.
2. **Multi-browser viewing**: Multiple browser tabs can connect to the same MCP server. All see the same canvas in real time (read-only viewers). The first browser (or the LLM) drives mutations via MCP tools.
3. **Multi-agent editing**: Multiple LLM agents connected to the same MCP server via stdio (MCP protocol) can coordinate edits. A locking or CRDT layer would be needed for conflict resolution.
4. **Long term**: A dedicated collaboration server with CRDT-based conflict resolution. The MCP server delegates to this server for multi-user sessions.

The WebSocket infrastructure built for browser sync (§4) directly enables collaborative viewing with zero additional code.

### 14.8 Remote Execution

Training on remote GPU clusters:

```
execute_training_remote(configDir: string, options: RemoteOptions): RemoteTrainingResult
  → Sends config to a remote training server, returns a job ID.

get_training_status(jobId: string): TrainingStatus
  → Polls remote server for job progress.

cancel_training(jobId: string): void
  → Cancels a remote training job.
```

The tool names `execute_training_remote`, `get_training_status`, and `cancel_training` are reserved.

### 14.9 Versioning & Backward Compatibility

The MCP tool API is versioned:

```
// Server announces its API version:
nnmodelling://server/version → { apiVersion: "1.0.0", serverVersion: "0.2.0" }
```

**Deprecation policy**:
- Tool names are never removed, only deprecated.
- Deprecated tools emit a warning in the response (not an error).
- New parameters are added with defaults that preserve old behavior.
- Breaking changes get a new tool name (e.g., `create_node_v2`).
- The LLM can check `nnmodelling://server/version` to determine which tools are available.

---

## 15. Future Evolution Roadmap

### Phase 1: Core MCP Server + Real-Time Sync (Target: 3 weeks)

| Item | Description |
|------|-------------|
| 1.1 | Extract `DiagramCore` from `Diagram.svelte.ts` (pure TS, no Svelte) |
| 1.2 | Implement `EventBus` in `core/EventBus.ts` (typed, monotonic seq, ring buffer) |
| 1.3 | Wire `DiagramCore` to emit `DomainEvent`s on every mutation |
| 1.4 | Extract `StereotypeCore` with Node.js loader (`fs`-based) |
| 1.5 | Modify `nnTree.ts` to accept `DiagramCore` |
| 1.6 | Set up `mcp-server/` package with workspace config |
| 1.7 | Implement MCP server bootstrap + tool registration |
| 1.8 | Implement graph manipulation tools (create_node, connect_nodes, delete_nodes, move_nodes, duplicate_nodes) |
| 1.9 | Implement parameter tools (set_parameter, update_parameters, query_parameters) |
| 1.10 | Implement inspection tools (get_graph, get_node, get_edges) |
| 1.11 | Implement selection tools |
| 1.12 | Implement validation tools |
| 1.13 | **Implement WebSocket server (`ws-server.ts`)** — subscribes to EventBus, converts `DomainEvent` → `DeltaOperation[]`, broadcasts `WSDeltaMessage`s |
| 1.14 | **Implement `DiagramSyncClient`** in browser (`front-end/src/sync/`) — connects to `ws://`, applies deltas to `$state.raw` |
| 1.15 | **Integration test**: LLM creates node via MCP → browser canvas updates in <10ms |
| 1.16 | Unit tests for all tools + EventBus + WS server + SyncClient |

### Phase 2: Transactions & History (Target: 1 week)

| Item | Description |
|------|-------------|
| 2.1 | Implement TransactionManager (buffered mutations, preview mode) |
| 2.2 | Implement HistoryManager (snapshot-based undo/redo, 50-entry stack) |
| 2.3 | Transaction tools (begin, commit, rollback) |
| 2.4 | History tools (undo, redo, get_history_status) |
| 2.5 | Integration: transaction + undo/redo + WebSocket (browser sees batched deltas on commit) |

### Phase 3: Pipeline Integration (Target: 1 week)

| Item | Description |
|------|-------------|
| 3.1 | Implement Python subprocess interface (pipeline.ts) |
| 3.2 | Implement compile_nntree tool |
| 3.3 | Implement execute_conversion tool |
| 3.4 | Implement execute_training tool (synchronous, blocking) |
| 3.5 | Implement execute_inference tool |
| 3.6 | Integration: full MNIST pipeline test (create → compile → convert → train → infer) |

### Phase 4: Visual Feedback Loop (Target: 1 week)

| Item | Description |
|------|-------------|
| 4.1 | Document LLM + glimpse + MCP real-time interaction pattern |
| 4.2 | Example scripts: "build MNIST classifier", "build autoencoder", "build transformer" |
| 4.3 | MCP Event Polling (`get_events` tool with cursor-based polling) |
| 4.4 | Stress test: 100-node graph created via MCP, verify browser renders all in <1s |

### Phase 5: Advanced Features (Target: 2 weeks)

| Item | Description |
|------|-------------|
| 5.1 | Canvas tools (fit_view, center_view) — sent via WebSocket as viewport deltas |
| 5.2 | Align and distribute tools |
| 5.3 | Subflow introspection tools |
| 5.4 | Optimize delta serialization (only send changed fields, not full node objects) |
| 5.5 | Template system (save, load, list) |

### Phase 6: Production Readiness (Target: 2 weeks)

| Item | Description |
|------|-------------|
| 6.1 | CLI packaging: `npx @nnmodelling/mcp-server` (starts MCP + WebSocket) |
| 6.2 | Comprehensive error documentation |
| 6.3 | Performance benchmarks (1000-node graph stress test, WS throughput) |
| 6.4 | CI pipeline for mcp-server (lint + test + build) |
| 6.5 | Integration with common LLM clients (Claude Desktop, etc.) |
| 6.6 | User guide: "Building Graphs with NNModelling MCP" |
| 6.7 | Vite dev server proxy: forward `/ws` to MCP server WebSocket port |

### Beyond Phase 6

| Item | Description |
|------|-------------|
| B.1 | Async training with progress events via WebSocket |
| B.2 | Remote GPU training (execute_training_remote + status polling) |
| B.3 | Auto-layout algorithms (dagre, force-directed, grid) |
| B.4 | Graph rewriting transforms (pattern match → replace) |
| B.5 | AI-assisted graph generation (LLM generates topology from description) |
| B.6 | Collaborative editing with CRDT conflict resolution |
| B.7 | Macro recording and playback |
| B.8 | Visual diff of diagram versions |
| B.9 | MCP server as embeddable library |
| B.10 | WebSocket auth (token-based) for multi-user deployments |

---

## 16. Implementation Plan

### 16.1 Prerequisites

Before implementing the MCP server, the following refactoring must be completed:

1. **Extract `DiagramCore`**: Move all business logic from `Diagram.svelte.ts` into a new `core/DiagramCore.ts` that has zero Svelte dependencies. The existing `Diagram` class becomes a thin wrapper with `$state.raw`.

2. **Implement `EventBus` + `DomainEvents`**: Create `core/EventBus.ts` (typed event emitter with monotonic `seq`) and `core/DomainEvents.ts` (event type definitions). Wire `DiagramCore` to emit events on every mutation.

3. **Extract `StereotypeCore`**: Add a Node.js-compatible loading strategy to the stereotype system. The existing `import.meta.glob` path is preserved for the browser; the Node.js path uses `fs`.

4. **Update `nnTree.ts`**: Change the constructor parameter from `Diagram` to `DiagramCore` (or an interface both implement).

5. **Extract validation**: Move validation logic out of `nnTree.ts` and `utils.ts` into `core/validation.ts` as standalone functions.

6. **Set up pnpm workspace**: Add `pnpm-workspace.yaml` at the root, configure `mcp-server/` as a workspace package, add `"@nnmodelling/front-end"` as a dependency of `mcp-server`.

7. **Add Vite proxy**: Configure `vite.config.ts` to proxy `/ws` requests to the MCP server's WebSocket port, so the browser dev server can connect seamlessly.

### 16.2 Package Configuration

```json
// mcp-server/package.json
{
  "name": "@nnmodelling/mcp-server",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "bin": {
    "nnmodelling-mcp": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@nnmodelling/front-end": "workspace:*",
    "ws": "^8.18.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.0",
    "typescript": "^5.8.0",
    "vitest": "^4.1.0"
  }
}
```

### 16.3 Key Implementation Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Transport (MCP) | stdio | MCP standard; works with all MCP clients |
| Transport (Browser) | WebSocket (`ws` library) | Real-time push; low overhead; event-driven API |
| State storage | In-memory `DiagramCore` | One session per MCP server instance |
| Event bus | Custom `EventBus` (typed, synchronous) | Single source for both WS broadcast and MCP polling; no external dep |
| Delta protocol | `WSDeltaMessage` with `DeltaOperation[]` | ~200 bytes per mutation vs ~50KB full snapshot; targeted array mutations |
| Stereotype loading | `StereotypeCore.loadFromDirectoryNode(path)` | Reads `Stereotypes/` from filesystem at server startup |
| Python calls | `child_process.spawn("uv", ["run", "python", ...])` | Existing pattern used by integration tests |
| Temp files | `os.tmpdir()/nnmodelling-{uuid}/` | Cleaned up on server shutdown |
| Node ID generation | `crypto.randomUUID()` | Already used by Diagram; available in Node.js |
| Logging | `console.error` (stderr) | MCP uses stdout for protocol; stderr for server logs |
| WebSocket port | Configurable via CLI `--ws-port` (default: 9339) | Avoids port conflicts; documented in server startup banner |

### 16.4 Testing Strategy

| Level | Tool | Scope |
|-------|------|-------|
| Unit | Vitest | Each tool handler tested in isolation with mocked DiagramCore |
| Unit | Vitest | EventBus: emit ordering, seq monotonicity, handler isolation |
| Unit | Vitest | WS server: DomainEvent → DeltaOperation conversion correctness |
| Unit | Vitest | DiagramSyncClient: delta application to mock `$state.raw` arrays |
| Integration | Vitest | WS server + EventBus + DiagramCore: mutation → event → delta → broadcast |
| Integration | Vitest | Full pipeline: create diagram → compile → convert (no browser) |
| E2E | Vitest + Python | Full pipeline: create → compile → convert → train (1 epoch) |
| E2E | Vitest + headless browser | MCP create_node → verify WS message received by sync client |
| LLM simulation | Vitest | Automated sequence of MCP calls simulating an LLM building a graph |

### 16.5 Success Criteria

The MCP server is successful when:

1. An LLM agent can build an MNIST classifier diagram (6 nodes, 5 edges) using only MCP tools.
2. The browser canvas updates in **real time** (<10ms) as each node/edge is created — no reloads, no file exchange.
3. The resulting diagram compiles to a valid NNTree.
4. `convert.py` generates valid Hydra configs from the NNTree.
5. `main.py` trains the model for 1 epoch without errors.
6. The entire pipeline (build → compile → convert → train) completes in a single automated test.
7. The LLM can use transaction + undo/redo to experiment with different graph topologies — browser reflects each undo/redo instantly.
8. The LLM can use glimpse screenshots to visually verify its work after MCP operations — the canvas is always current.
9. On browser reconnect, the full diagram state is restored via snapshot without data loss.
10. The WebSocket server handles 100+ delta messages per second without dropping events.
