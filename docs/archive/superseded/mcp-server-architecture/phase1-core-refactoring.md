# Phase 1: Core Refactoring — Implementation Plan

**Status**: Ready for implementation  
**Depends on**: Nothing (this is the first phase)  
**Target duration**: 2–3 days for a single developer  
**Risk**: Moderate — we are restructuring the internal architecture of a working app  
**Rollback strategy**: Every step is a git commit. If any step fails, revert to the previous commit.

---

## Objective

Extract all business logic from the Svelte-specific frontend into a pure TypeScript core (`front-end/src/core/`). The existing Svelte app must continue to function **identically** after this phase. No new tools, no MCP server, no WebSockets. This phase is a **zero user-facing change** refactoring.

### What Must Still Work After Phase 1

| Check | Command | Expected |
|-------|---------|----------|
| Type checking | `npm run check` | Zero errors |
| Unit tests | `npm run test` | All 76 tests pass |
| Integration tests | `npm run test:integration:smoke` | All Tier 0 tests pass |
| Dev server | `npm run dev` | App loads, nodes can be dragged, created, deleted, connected |
| Production build | `npm run build` | Builds without errors |

---

## Architecture of the Extraction

```
BEFORE (current)                          AFTER (Phase 1)
───────────────                           ────────────────
Diagram.svelte.ts                         core/DiagramCore.ts    ← pure TS, no Svelte
  - $state.raw (Svelte rune)                - nodes: Node[]
  - all business logic                      - edges: Edge[]
  - stereotypes                             - all business logic
  - addModule, deleteNode, etc.             - events: EventBus
                                            - stereotypes
stereotype.ts                             core/StereotypeCore.ts ← pure TS, dual loader
  - import.meta.glob (Vite)                 - Constructor
  - Stereotype class                        - loadFromDirectory() (Vite)
  - ModuleParameter, StereotypeView         - loadFromDirectoryNode(path) (fs)
                                            - ModuleParameter, StereotypeView
utils.ts                                  core/validation.ts     ← standalone fns
  - checkValidConnection                    - checkValidConnection
  - onNodeDragStop (reparenting)            - validateGraph
                                            - validateConnections

                                            core/EventBus.ts      ← new
                                            core/DomainEvents.ts  ← new
                                            core/types.ts         ← shared types

Diagram.svelte.ts (modified)              stereotype.ts (modified)
  - import { DiagramCore }                   - import { StereotypeCore }
  - export class Diagram extends DiagramCore   - export class Stereotype extends StereotypeCore
  - only adds $state.raw wrapping             - delegates to StereotypeCore.loadFromDirectory()

                                            utils.ts (modified)
                                              - re-exports from core/validation.ts
                                              - onNodeDragStop, handleSaveModel,
                                                handleLoadModel remain unchanged
```

---

## Step-by-Step Task List

### Step 0: Create the Core Directory

```bash
mkdir -p front-end/src/core
```

Create the empty module barrel files that will be populated in subsequent steps.

---

### Step 1: Create `core/types.ts` — Shared Type Definitions

**File**: `front-end/src/core/types.ts`

This module contains all shared type definitions used by both `DiagramCore` and future consumers (MCP server, WebSocket server, browser sync client). It must have **zero runtime dependencies** — only type imports from `@xyflow/svelte`.

**Contents to extract / create**:

```typescript
// Re-export Svelte Flow types (type-only — no runtime dependency)
import type { Node, Edge } from "@xyflow/svelte";
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
  seq: number;
  timestamp: number;
  transactionId?: string;
  payload: T;
}

// ── WebSocket Messages ─────────────────────────
export type WSMessageType = "snapshot" | "delta";

export interface WSSnapshotMessage {
  type: "snapshot";
  seq: number;
  nodes: Node[];
  edges: Edge[];
}

export interface WSDeltaMessage {
  type: "delta";
  seq: number;
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
  | { op: "graph_reset";   nodes: Node[]; edges: Edge[] };

// ── Position ────────────────────────────────────
export interface Position { x: number; y: number; }

// ── Node Configuration ──────────────────────────
export interface NodeConfig {
  name?: string;
  color?: string;
  width?: number;
  height?: number;
  params?: Record<string, any>;
}

export interface JoinNodeConfig extends NodeConfig {
  inputsCount?: number;
}

export interface EdgeConfig {
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

// ── Selection ───────────────────────────────────
export interface Selection {
  nodeIds: string[];
  edgeIds: string[];
}

// ── Snapshots ───────────────────────────────────
export interface DiagramCoreSnapshot {
  nodes: Node[];
  edges: Edge[];
}

export interface DiagramSnapshot extends DiagramCoreSnapshot {
  timestamp: number;
  description: string;
}

// ── Canvas State ────────────────────────────────
export interface CanvasState {
  zoom: number;
  x: number;
  y: number;
}

// ── Graph Statistics ────────────────────────────
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

// ── NNTree Output ───────────────────────────────
export interface NNTreeOutput {
  json: string;
  root: string;
  nodeCount: number;
  subflowCount: number;
  lossNodeType: string | null;
}
```

**Verification**: `npx tsc --noEmit` in `front-end/` — this file alone should compile without errors.

**Commit**: `git add front-end/src/core/types.ts && git commit -m "feat(core): add shared type definitions"`

---

### Step 2: Create `core/EventBus.ts` — Typed Event Emitter

**File**: `front-end/src/core/EventBus.ts`

A pure TypeScript event emitter with monotonic sequence numbers. Zero dependencies beyond `core/types.ts`.

```typescript
import type { DomainEvent, DomainEventType } from "./types";

export type EventHandler<T = Record<string, unknown>> = (event: DomainEvent<T>) => void;

export class EventBus {
  private handlers = new Map<DomainEventType, Set<EventHandler<any>>>();
  private anyHandlers = new Set<EventHandler<any>>();
  private seq: number = 0;
  private buffer: DomainEvent[] = [];
  private readonly maxBufferSize: number = 1000;

  /** Subscribe to a specific event type. Returns unsubscribe function. */
  on<T>(type: DomainEventType, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  /** Subscribe to ALL event types. Used by WebSocket server for blind broadcast. */
  onAny(handler: EventHandler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  /** Emit an event. Called synchronously by DiagramCore after every mutation. */
  emit<T>(type: DomainEventType, payload: T, transactionId?: string): void {
    this.seq++;
    const event: DomainEvent<T> = {
      type,
      seq: this.seq,
      timestamp: Date.now(),
      transactionId,
      payload,
    };

    // Ring buffer for late subscribers
    this.buffer.push(event as DomainEvent);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }

    // Notify type-specific handlers
    const typed = this.handlers.get(type);
    if (typed) {
      for (const h of typed) h(event);
    }

    // Notify catch-all handlers (WebSocket server)
    for (const h of this.anyHandlers) h(event);
  }

  /** Get all events since a given sequence number (exclusive). Used by MCP get_events. */
  getEventsSince(lastSeq: number): DomainEvent[] {
    return this.buffer.filter(e => e.seq > lastSeq);
  }

  getCurrentSeq(): number { return this.seq; }

  clear(): void {
    this.seq = 0;
    this.buffer = [];
    // Handlers are NOT cleared — only the event log is reset
  }
}
```

**Verification**: No compilation needed (no external deps, pure TS). Write a quick smoke test:

```typescript
// Temporarily in core/__EventBus.smoke.ts — delete after verifying
import { EventBus } from "./EventBus";
const bus = new EventBus();
let called = false;
bus.on("node_created", (e) => { called = true; console.assert(e.seq === 1); });
bus.emit("node_created", { nodeId: "test" });
console.assert(called, "Handler should have been called");
console.assert(bus.getCurrentSeq() === 1);
console.log("EventBus smoke test passed");
```

**Commit**: `git add front-end/src/core/EventBus.ts && git commit -m "feat(core): add EventBus with monotonic sequencing"`

---

### Step 3: Create `core/StereotypeCore.ts` — Dual-Loader Stereotype System

**File**: `front-end/src/core/StereotypeCore.ts`

This is the most delicate extraction. The current `stereotype.ts` has:
- Zero imports
- One class `Stereotype` with `loadFromDirectory()` using `import.meta.glob`
- Interfaces `ModuleParameter`, `StereotypeView`, `StereotypeJson`

**Strategy**: Create `StereotypeCore` as an identical copy of the current `Stereotype` class, then modify `stereotype.ts` to extend `StereotypeCore`.

**The dual-loader problem**: `import.meta.glob` is a Vite compile-time transform. It does not exist in Node.js. We need two loading strategies:

1. **Browser (Vite)**: `StereotypeCore.loadFromDirectory()` uses `import.meta.glob`
2. **Node.js (MCP server)**: `StereotypeCore.loadFromDirectoryNode(stereotypesDir: string)` uses `fs.readdirSync`

**Implementation**:

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
  public readonly id: string;
  public readonly name: string;
  public readonly category: string;
  public readonly pythonClassName: string;
  public readonly taskType: string;
  public readonly expr: string;
  public readonly parameters: Record<string, ModuleParameter>;
  public readonly view: StereotypeView;
  public readonly isJoin: boolean;
  public readonly isInput: boolean;
  public readonly isLoss: boolean;
  public readonly isSubFlow: boolean;

  constructor(filePath: string, data: StereotypeJson) {
    this.id = filePath;

    // Extract name from filename
    const parts = filePath.split("/");
    const nameWithExt = parts[parts.length - 1] || filePath;
    const dotIndex = nameWithExt.lastIndexOf(".");
    this.name = dotIndex > 0 ? nameWithExt.substring(0, dotIndex) : nameWithExt;

    this.category = data.category || "Uncategorized";
    this.pythonClassName = data.pythonClassName || "";
    this.taskType = data.taskType || "";
    this.expr = data.expr || "";

    this.parameters = {};
    if (data.params) {
      for (const [key, param] of Object.entries(data.params)) {
        this.parameters[key] = {
          type: param.type || "string",
          default: param.default || "",
          position: param.position,
        };
      }
    }

    const view = data.view || {};
    this.view = {
      color: view.color || "#4779c4",
      width: view.width || 140,
      height: view.height || 60,
    };

    // Category flags
    this.isJoin   = data.category === "Join"   || filePath.includes("/Joins/");
    this.isInput  = data.category === "Input";
    this.isLoss   = data.category === "Loss";
    this.isSubFlow = data.category === "Subflow" || filePath.includes("/SubFlows/");
  }

  // ── Vite loader (browser) ─────────────────────
  // Uses import.meta.glob — a Vite compile-time feature.
  // This method is only callable in the browser/Vite context.
  public static loadFromDirectory(): StereotypeCore[] {
    const files = import.meta.glob('../../Stereotypes/**/*.json', { eager: true }) as Record<string, any>;
    const loaded: StereotypeCore[] = [];

    for (const [path, rawData] of Object.entries(files)) {
      const jsonData = rawData.default || rawData;
      try {
        loaded.push(new StereotypeCore(path, jsonData));
      } catch (e) {
        console.error(`Error loading stereotype from ${path}:`, e);
      }
    }

    return loaded.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── Node.js loader (MCP server) ────────────────
  // Uses fs.readdirSync + JSON.parse for Node.js environments.
  // The stereotypesDir parameter is an absolute path to the Stereotypes/ directory.
  public static loadFromDirectoryNode(stereotypesDir: string): StereotypeCore[] {
    // Dynamic import to avoid bundling 'fs' and 'path' in the browser build
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");

    const loaded: StereotypeCore[] = [];

    function walkDir(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.name.endsWith(".json")) {
          try {
            const content = fs.readFileSync(fullPath, "utf-8");
            const jsonData = JSON.parse(content);
            loaded.push(new StereotypeCore(fullPath, jsonData));
          } catch (e) {
            console.error(`Error loading stereotype from ${fullPath}:`, e);
          }
        }
      }
    }

    walkDir(stereotypesDir);
    return loaded.sort((a, b) => a.name.localeCompare(b.name));
  }
}
```

**Important**: The `loadFromDirectoryNode` method uses CommonJS `require("fs")` and `require("path")` to avoid tree-shaking issues in the browser build. Vite will not bundle `fs` for the browser — but it won't tree-shake a dynamic `require()` either. The browser never calls this method, so it's dead code in that context.

**Verification**: 

1. In the browser: `StereotypeCore.loadFromDirectory()` should return 35 stereotypes
2. In Node.js: `StereotypeCore.loadFromDirectoryNode("/absolute/path/to/Stereotypes")` should return 35 stereotypes

```bash
# Quick Node.js smoke test
node -e "
const { StereotypeCore } = require('./dist/core/StereotypeCore.js');  // after build
// or use tsx for dev:
"
```

**Commit**: `git add front-end/src/core/StereotypeCore.ts && git commit -m "feat(core): add StereotypeCore with dual Vite/Node loader"`

---

### Step 4: Create `core/validation.ts` — Standalone Validation

**File**: `front-end/src/core/validation.ts`

Extract `checkValidConnection` from `utils.ts` and make it operate on plain arrays instead of a `Diagram` instance.

```typescript
import type { Edge } from "@xyflow/svelte";

export interface ConnectionValidation {
  valid: boolean;
  reason?: string;
}

export interface ValidationError {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidationWarning {
  code: string;
  message: string;
  nodeId?: string;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/**
 * Check if a connection is valid based on target handle availability.
 * Extracted from utils.ts:checkValidConnection — operates on plain Edge[],
 * not a Diagram instance.
 */
export function checkValidConnection(
  edges: Edge[],
  source: string,
  target: string,
  sourceHandle?: string,
  targetHandle?: string
): ConnectionValidation {
  // Self-loop check
  if (source === target) {
    return { valid: false, reason: "Cannot connect a node to itself" };
  }

  // Target handle occupancy check
  const isTargetTaken = edges.some(
    (e) => e.target === target && e.targetHandle === targetHandle
  );

  if (isTargetTaken) {
    return { valid: false, reason: `Target handle '${targetHandle}' on node '${target}' is already occupied` };
  }

  return { valid: true };
}

// Future: validateGraph, validateConnections, validateParameters, validateSubflows
// will be added here in Phase 2 when the MCP server needs them.
// For Phase 1, only checkValidConnection is extracted.
```

**Note**: The current `checkValidConnection` in `utils.ts` takes `diagram: Diagram` as its first parameter. The extracted version takes `edges: Edge[]` instead. `utils.ts` will be updated in Step 7 to wrap this function, passing `diagram.edges`.

**Verification**: None independently — verified when `utils.ts` is updated in Step 7.

**Commit**: `git add front-end/src/core/validation.ts && git commit -m "feat(core): extract connection validation to core/validation.ts"`

---

### Step 5: Create `core/DiagramCore.ts` — Pure State Management

**File**: `front-end/src/core/DiagramCore.ts`

This is the central extraction. All business logic from `Diagram.svelte.ts` (addModule, deleteNodes, connectNodes, etc.) moves here. The only things left in `Diagram.svelte.ts` will be:
- `$state.raw` wrapping
- Constructor that calls `super()` and adds Svelte-specific initialization

**Extraction strategy**: 
1. Copy `Diagram.svelte.ts` → `core/DiagramCore.ts`
2. Remove `$state.raw` (replace with plain array initialization)
3. Remove the auto-spawn Input node from the constructor (moved to `Diagram.svelte.ts` wrapper)
4. Add `EventBus` integration (emit events on every mutation)
5. Change `Stereotype` → `StereotypeCore` throughout

**Construction approach**: Rather than building `DiagramCore` from scratch, we **copy the existing `Diagram.svelte.ts`**, make surgical modifications, then rewrite `Diagram.svelte.ts` to extend it.

**Surgical changes to make**:

| Original (Diagram.svelte.ts) | Modified (DiagramCore.ts) |
|---|---|
| `public nodes: Node[] = $state.raw<Node[]>([])` | `public nodes: Node[] = []` |
| `public edges: Edge[] = $state.raw<Edge[]>([])` | `public edges: Edge[] = []` |
| `public stereotypes: Stereotype[]` | `public stereotypes: StereotypeCore[]` |
| `import { Stereotype } from "./stereotype"` | `import { StereotypeCore } from "./StereotypeCore"` |
| Constructor loads stereotypes + auto-spawns Input | Constructor loads stereotypes only (no auto-spawn) |
| No event emission | `this.events.emit(...)` after every mutation |
| No `events` property | `public readonly events = new EventBus()` |
| `import type { Node, Edge } from "@xyflow/svelte"` | Same (unchanged) |

**Event emission points** (add after each mutation):

| Method | Event(s) to emit |
|--------|-----------------|
| `addModule` (after `this.nodes = [...]`) | `"node_created"`, `"graph_changed"` |
| `addJoinNode` | `"node_created"`, `"graph_changed"` |
| `addSubGraph` | `"node_created"`, `"graph_changed"` |
| `updateModule` | `"node_updated"`, `"graph_changed"` |
| `deleteNodes` | `"node_deleted"`, `"edge_deleted"` (for attached edges), `"graph_changed"` |
| `deleteEdges` | `"edge_deleted"`, `"graph_changed"` |
| `toggleSubflow` | `"subflow_toggled"`, `"graph_changed"` |
| `importFromJson` | `"diagram_imported"`, `"graph_changed"` |
| `moveNode` / `moveNodes` | `"node_moved"`, `"graph_changed"` |
| `selectNodes` / `clearSelection` | `"selection_changed"` |

Also add these methods that don't exist yet in `Diagram.svelte.ts`:
- `addEdge(source, target, sourceHandle?, targetHandle?): Edge`
- `removeEdge(source, target, targetHandle?): void`
- `reconnectEdge(edgeId, newSource?, newTarget?, newSourceHandle?, newTargetHandle?): void`
- `moveNode(id, x, y): void` (convenience wrapper)
- `moveNodes(positions): void` (batch position update)
- `getSnapshot(): DiagramCoreSnapshot`
- `restoreSnapshot(snapshot): void`
- `compileNNTree(): NNTree`
- `checkValidConnection(source, target, sourceHandle?, targetHandle?): boolean`

**The `addEdge` method** (new — not yet in Diagram):

```typescript
addEdge(
  source: string,
  target: string,
  sourceHandle: string = "out",
  targetHandle: string = "in"
): Edge {
  // Validate
  const validation = checkValidConnection(this.edges, source, target, sourceHandle, targetHandle);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  const newEdge: Edge = {
    id: `edge_${crypto.randomUUID()}`,
    source,
    target,
    sourceHandle,
    targetHandle,
  };

  this.edges = [...this.edges, newEdge];
  this.events.emit("edge_created", { edgeId: newEdge.id, source, target, sourceHandle, targetHandle });
  this.events.emit("graph_changed", { nodeCount: this.nodes.length, edgeCount: this.edges.length });

  return newEdge;
}
```

**The `compileNNTree` method** (thin wrapper):

```typescript
compileNNTree(): NNTree {
  // Dynamic import to avoid circular dependency at module level
  // (NNTree imports DiagramCore, DiagramCore references NNTree type)
  const { NNTree } = require("../conversion/nnTree") as typeof import("../conversion/nnTree");
  return new NNTree(this);
}
```

Wait — this won't work with ESM. Better approach: the `NNTree` import is type-only at the top, and the actual instantiation happens via a static method or by having the caller construct `NNTree` themselves. We'll address this in Step 6 when updating `nnTree.ts`.

For now, `DiagramCore` does NOT call `new NNTree()` — that's the caller's responsibility. Instead, `DiagramCore` exposes `getSnapshot()` and the caller passes it (or `this`) to `NNTree`.

**Full `DiagramCore.ts` structure**:

```
front-end/src/core/DiagramCore.ts (~350 lines)
├── Imports: Node, Edge (types from @xyflow/svelte)
│            StereotypeCore from ./StereotypeCore
│            EventBus from ./EventBus
│            checkValidConnection from ./validation
│            DiagramCoreSnapshot from ./types
├── export class DiagramCore
│   ├── Public state: nodes, edges, stereotypes, events
│   ├── Constructor: loads stereotypes via StereotypeCore.loadFromDirectory()
│   │                 (NO auto-spawn Input — that's Svelte-specific)
│   ├── Stereotype: getStereotype(), layerStereotypes, joinStereotypes
│   ├── Node CRUD: addModule(), addJoinNode(), addSubGraph(),
│   │              updateNode(), deleteNode(), deleteNodes(),
│   │              deleteEdge(), deleteEdges(), getNodeById()
│   ├── Connection: addEdge(), removeEdge(), reconnectEdge()
│   ├── Position: moveNode(), moveNodes()
│   ├── Graph Queries: getChildren(), getParents(),
│   │                  getSubflowNodes(), getSubflowEdges()
│   ├── Selection: selectNodes(), clearSelection(),
│   │              getSelectedNodes(), getSelectedEdges()
│   ├── Subflow: toggleSubflow()
│   ├── Serialization: exportToJson(), importFromJson(),
│   │                  getSnapshot(), restoreSnapshot()
│   ├── Validation: checkValidConnection()
│   ├── Identity: nextNodeName()
│   └── Private: getDefaultParams()
```

**Verification**: `npx tsc --noEmit` in `front-end/`. This file should compile without errors (except possibly the `NNTree` import — see Step 6).

**Commit**: `git add front-end/src/core/DiagramCore.ts && git commit -m "feat(core): extract DiagramCore with EventBus integration"`

---

### Step 6: Update `nnTree.ts` — Accept DiagramCore Instead of Diagram

**File**: `front-end/src/conversion/nnTree.ts`

**Changes required**:

1. Line 1: Change import
   ```typescript
   // Before:
   import { Diagram } from "../Diagram.svelte";
   // After:
   import type { DiagramCore } from "../core/DiagramCore";
   ```
   Only the **type** is needed — `DiagramCore` is never instantiated in `nnTree.ts`.

2. Line 9: Change constructor parameter
   ```typescript
   // Before:
   constructor(diagram: Diagram) {
   // After:
   constructor(diagram: DiagramCore) {
   ```

3. That's it. `nnTree.ts` only uses 5 things from `Diagram`:
   - `diagram.nodes` → exists on `DiagramCore`
   - `diagram.edges` → exists on `DiagramCore`
   - `diagram.getChilds(id)` → exists on `DiagramCore`
   - `diagram.getParents(id)` → exists on `DiagramCore`
   - `diagram.getStereotype(name)` → exists on `DiagramCore`

   All of these are present on `DiagramCore` with the same signatures. No other changes are needed.

**Verification**:
- `npx tsc --noEmit` should pass
- `npm run test` — all existing unit tests that use `new NNTree(diagram)` should still pass, because `Diagram` extends `DiagramCore`

**Commit**: `git add front-end/src/conversion/nnTree.ts && git commit -m "refactor(nnTree): accept DiagramCore instead of Diagram"`

---

### Step 7: Rewrite `Diagram.svelte.ts` — Thin Svelte Wrapper

**File**: `front-end/src/Diagram.svelte.ts`

This file becomes a thin wrapper that adds `$state.raw` reactivity and the auto-spawn Input node. All business logic is delegated to `DiagramCore`.

```typescript
// front-end/src/Diagram.svelte.ts
import { type Node, type Edge } from "@xyflow/svelte";
import { DiagramCore } from "./core/DiagramCore";
import { StereotypeCore } from "./core/StereotypeCore";
import { Stereotype } from "./stereotype";  // keep the Vite-loaded Stereotype

export class Diagram extends DiagramCore {
  // Override with Svelte 5 reactivity
  public nodes: Node[] = $state.raw<Node[]>([]);
  public edges: Edge[] = $state.raw<Edge[]>([]);

  // Keep the Stereotype array for backward compat (Vite-loaded)
  // DiagramCore.stereotypes is StereotypeCore[], but we want Stereotype[]
  // Solution: we DON'T override stereotypes — DiagramCore loads StereotypeCore
  // and the existing getter logic returns StereotypeCore instances.
  //
  // Actually, for backward compat, we need to keep Stereotype.stereotypes as the
  // source. Let's rethink...

  // REVISED APPROACH:
  // We DON'T call super()'s stereotype loading. Instead, we load Stereotypes
  // using the Vite loader (Stereotype.loadFromDirectory) and store them in
  // DiagramCore's stereotypes array. Since Stereotype extends StereotypeCore,
  // this is type-safe.

  constructor() {
    // Skip DiagramCore's constructor (don't load stereotypes there)
    // DiagramCore has a no-arg constructor that does nothing
    // We load stereotypes ourselves with the Vite loader
    super.__initStereotypes(Stereotype.loadFromDirectory());

    // Auto-spawn Input node (Svelte-specific behavior)
    const inputStereotype = this.stereotypes.find(s => s.isInput);
    if (inputStereotype && this.nodes.length === 0) {
      this.addModule(
        inputStereotype,
        // Center of viewport — Svelte-specific
        (typeof window !== "undefined" ? window.innerWidth : 1024) / 2 - 15,
        50
      );
    }
  }
}
```

**Wait — this has a problem.** We said we want `DiagramCore` to have its own stereotype loading, but the `Diagram` (Svelte) needs to use `Stereotype.loadFromDirectory()` which uses Vite's `import.meta.glob`. The `DiagramCore` should NOT call `loadFromDirectory()` in its constructor — it should accept stereotypes as a parameter or have them set after construction.

**Revised design for `DiagramCore` constructor**:

```typescript
// DiagramCore.ts — does NOT load stereotypes automatically
export class DiagramCore {
  public nodes: Node[] = [];
  public edges: Edge[] = [];
  public stereotypes: StereotypeCore[] = [];
  public readonly events = new EventBus();

  // Stereotypes are injected, not loaded internally.
  // This allows different loading strategies (Vite glob vs Node fs).
  initStereotypes(stereotypes: StereotypeCore[]): void {
    this.stereotypes = stereotypes;
  }
}
```

And in `Diagram.svelte.ts`:

```typescript
export class Diagram extends DiagramCore {
  public nodes: Node[] = $state.raw<Node[]>([]);
  public edges: Edge[] = $state.raw<Edge[]>([]);

  constructor() {
    super();
    // Load stereotypes using Vite glob, inject into DiagramCore
    this.initStereotypes(Stereotype.loadFromDirectory());

    // Auto-spawn Input node
    const inputStereotype = this.stereotypes.find(s => s.isInput);
    if (inputStereotype && this.nodes.length === 0) {
      const centerX = (typeof window !== "undefined" ? window.innerWidth : 1024) / 2 - 15;
      this.addModule(inputStereotype, centerX, 50);
    }
  }
}
```

This is cleaner. `DiagramCore` is agnostic about how stereotypes are loaded.

**Notes on `$state.raw` overriding**:
- `Diagram.nodes` and `Diagram.edges` override `DiagramCore.nodes` and `DiagramCore.edges`
- When `DiagramCore` methods do `this.nodes = [...]`, they are writing to `Diagram.nodes` (the `$state.raw` version) because `this` resolves to the `Diagram` instance
- This means Svelte reactivity kicks in automatically — no code changes needed in the mutation methods

**Verification**:
1. `npm run check` — zero type errors
2. `npm run test` — all 76 unit tests pass (they use `new Diagram()` which now extends `DiagramCore`)
3. `npm run dev` — app loads, Input node is auto-spawned, all interactions work

**Rollback if this fails**: Revert to the previous commit. The old `Diagram.svelte.ts` is untouched in git until we commit.

**Commit**: `git add front-end/src/Diagram.svelte.ts && git commit -m "refactor(diagram): make Diagram a thin Svelte wrapper around DiagramCore"`

---

### Step 8: Update `stereotype.ts` — Extend StereotypeCore

**File**: `front-end/src/stereotype.ts`

Make `Stereotype` extend `StereotypeCore` and delegate to the Vite loader.

```typescript
// front-end/src/stereotype.ts
import { StereotypeCore, type StereotypeJson } from "./core/StereotypeCore";

// Re-export interfaces for backward compatibility
export type { ModuleParameter, StereotypeView, StereotypeJson } from "./core/StereotypeCore";

export class Stereotype extends StereotypeCore {
  constructor(filePath: string, data: StereotypeJson) {
    super(filePath, data);
  }

  // Override with Vite-specific loader
  public static loadFromDirectory(): Stereotype[] {
    // Delegate to StereotypeCore's Vite loader, cast to Stereotype[]
    return StereotypeCore.loadFromDirectory() as Stereotype[];
  }
}
```

Since `Stereotype` extends `StereotypeCore`, all existing code that uses `Stereotype` continues to work. The `stereotype` property on nodes still holds a `Stereotype` instance (which is also a `StereotypeCore`).

**Note**: `StereotypeCore.loadFromDirectory()` returns `StereotypeCore[]`. Since `Stereotype` extends `StereotypeCore` and adds no new fields, the cast is safe — the constructor is the same, the properties are the same.

**Verification**: `npm run check` and `npm run test`

**Commit**: `git add front-end/src/stereotype.ts && git commit -m "refactor(stereotype): Stereotype extends StereotypeCore"`

---

### Step 9: Update `utils.ts` — Delegate to Core Validation

**File**: `front-end/src/utils.ts`

Change `checkValidConnection` to use the core version:

```typescript
// Line 2: Change import
// Before:
import type { Diagram } from "./Diagram.svelte";
// After:
import type { Diagram } from "./Diagram.svelte";  // Keep for onNodeDragStop, handleSaveModel, handleLoadModel
import { checkValidConnection as coreCheckValidConnection } from "./core/validation";

// Lines 173-183: Replace checkValidConnection
export function checkValidConnection(diagram: Diagram, connection: Connection | Edge): boolean {
  const result = coreCheckValidConnection(
    diagram.edges,
    connection.source,
    connection.target,
    connection.sourceHandle ?? undefined,
    connection.targetHandle ?? undefined
  );
  return result.valid;
}
```

The other functions (`onNodeDragStop`, `handleSaveModel`, `handleLoadModel`) remain unchanged — they will still work because `Diagram extends DiagramCore`.

**Verification**: `npm run test` — connection validation tests should pass.

**Commit**: `git add front-end/src/utils.ts && git commit -m "refactor(utils): delegate checkValidConnection to core/validation"`

---

### Step 10: Update All Import Paths in the Frontend

**Files to scan and update**:

All `.svelte` and `.ts` files that import from `./stereotype` or `./Diagram.svelte` need their import paths checked. Since we kept the same exports from `stereotype.ts` and `Diagram.svelte.ts`, most imports should work unchanged.

**Files to verify** (nothing should change, but verify compilation):

| File | Import | Status |
|------|--------|--------|
| `FlowCanvas.svelte` | `import { Diagram } from "./Diagram.svelte"` | Unchanged — `Diagram` still exported from same path |
| `Sidebar.svelte` | Uses `diagram.getStereotype()` etc. | Unchanged — methods still exist |
| `CustomNode.svelte` | Uses node data | Unchanged |
| `JoinNode.svelte` | Uses node data | Unchanged |
| `SubflowNode.svelte` | Uses node data + callbacks | Unchanged |
| `SDropdown.svelte` | Uses stereotype list | Unchanged |
| `__tests__/helpers.ts` | Creates mock nodes | Unchanged |
| `__tests__/nnTree.test.ts` | `new Diagram()` | Still works (Diagram extends DiagramCore) |
| `__tests__/utils.test.ts` | `checkValidConnection(diagram, ...)` | Still works (same signature) |

**Verification**: `npm run check` — zero errors across all files.

**Commit**: No changes needed if zero errors. If any import needs fixing, commit those fixes:
`git add -A && git commit -m "fix: update import paths after core extraction"`

---

### Step 11: Run Full Test Suite

```bash
cd front-end

# Type checking
npm run check

# Unit tests
npm run test

# Integration smoke tests (Tier 0 — NNTree compilation only)
npm run test:integration:smoke

# Manual verification
npm run dev
# → Open browser
# → Verify: Input node is auto-spawned
# → Drag node: positions update
# → Create node from sidebar: appears on canvas
# → Connect nodes: edge appears
# → Delete node: removed
# → Save/Load: works
# → Convert to Python: NNTree JSON downloads
# → Toggle subflow: collapse/expand works
```

**If ALL pass**: Phase 1 is complete. Tag the commit:

```bash
git tag phase1-complete
git commit --allow-empty -m "Phase 1 complete: core extraction, all tests pass"
```

**If ANY test fails**: Debug the failure against the specific change that caused it. Roll back to the last known-good commit if the fix is not obvious.

---

## Dependency Graph for Phase 1

```
Step 1: types.ts           (no deps)
Step 2: EventBus.ts        → types.ts
Step 3: StereotypeCore.ts  → types.ts
Step 4: validation.ts      → types.ts (Edge type only)
Step 5: DiagramCore.ts     → types.ts, EventBus, StereotypeCore, validation
Step 6: nnTree.ts          → DiagramCore (type only)
Step 7: Diagram.svelte.ts  → DiagramCore, StereotypeCore, Stereotype
Step 8: stereotype.ts      → StereotypeCore
Step 9: utils.ts           → validation.ts
Step 10: import path check → everything above
Step 11: test suite        → everything above
```

Steps 1–4 can be done in parallel (they have no mutual dependencies).
Steps 5–9 must be sequential.
Steps 10–11 are verification.

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| `$state.raw` override doesn't trigger reactivity | Svelte 5 resolves `this.nodes` at call time. Since `this` is the `Diagram` instance, writing to `this.nodes` writes to the `$state.raw` version. Verified by the fact that existing code already does `this.nodes = [...]` and reactivity works. |
| `Stereotype extends StereotypeCore` breaks type inference | `Stereotype.loadFromDirectory()` returns `Stereotype[]`. Existing code that uses `stereotype.isJoin` etc. will work because those properties are inherited from `StereotypeCore`. |
| `NNTree` constructor signature change breaks tests | `Diagram extends DiagramCore`, so `new NNTree(diagram)` still type-checks. The parameter type changed from `Diagram` to `DiagramCore`, which is a supertype — any `Diagram` instance is also a `DiagramCore`. |
| File size explosion in `DiagramCore.ts` | `DiagramCore.ts` will be ~350 lines — same as the current `Diagram.svelte.ts`. This is acceptable. Future: extract subflow logic into a separate module if needed. |
| `import.meta.glob` not available in Node.js tests | No Node.js tests exist yet. The browser (Vite) handles `import.meta.glob` at build time. Node.js consumers use `loadFromDirectoryNode`. |

---

## Checkpoint Summary

| Step | What | Verification | Commit Message |
|------|------|-------------|----------------|
| 1 | `core/types.ts` | `tsc --noEmit` | `feat(core): add shared type definitions` |
| 2 | `core/EventBus.ts` | Manual smoke test | `feat(core): add EventBus with monotonic sequencing` |
| 3 | `core/StereotypeCore.ts` | Vite + Node.js loader smoke | `feat(core): add StereotypeCore with dual Vite/Node loader` |
| 4 | `core/validation.ts` | `tsc --noEmit` | `feat(core): extract connection validation to core/validation.ts` |
| 5 | `core/DiagramCore.ts` | `tsc --noEmit` | `feat(core): extract DiagramCore with EventBus integration` |
| 6 | `nnTree.ts` update | `tsc --noEmit` | `refactor(nnTree): accept DiagramCore instead of Diagram` |
| 7 | `Diagram.svelte.ts` | `tsc --noEmit` | `refactor(diagram): make Diagram a thin Svelte wrapper around DiagramCore` |
| 8 | `stereotype.ts` update | `tsc --noEmit` | `refactor(stereotype): Stereotype extends StereotypeCore` |
| 9 | `utils.ts` update | `tsc --noEmit` | `refactor(utils): delegate checkValidConnection to core/validation` |
| 10 | Import path audit | `npm run check` | (only if fixes needed) |
| 11 | Full test suite | All pass | Tag: `phase1-complete` |

---

## Files Created (Phase 1)

```
front-end/src/core/
├── types.ts              # Step 1 — shared type definitions
├── EventBus.ts           # Step 2 — typed event emitter
├── StereotypeCore.ts     # Step 3 — pure TS stereotype with dual loader
├── validation.ts         # Step 4 — standalone validation functions
└── DiagramCore.ts        # Step 5 — pure TS diagram state management
```

## Files Modified (Phase 1)

```
front-end/src/
├── Diagram.svelte.ts     # Step 7 — thin Svelte wrapper
├── stereotype.ts         # Step 8 — extends StereotypeCore
├── conversion/nnTree.ts  # Step 6 — accepts DiagramCore
└── utils.ts              # Step 9 — delegates to core/validation
```
