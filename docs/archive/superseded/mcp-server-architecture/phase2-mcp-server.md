# Phase 2: MCP Server & Real-Time Sync — Implementation Plan

**Status**: Ready for implementation
**Depends on**: Phase 1 complete (`phase1-complete` tag)
**Target duration**: 4–5 days for a single developer
**Risk**: Moderate-High — new package, new transport, real-time sync

---

## Objective

Build the full MCP server package (`mcp-server/`), wire it to the `DiagramCore` extracted in Phase 1, implement the WebSocket delta broadcaster, and connect the browser via `DiagramSyncClient`. After this phase, an LLM can manipulate the diagram via MCP tools, and the browser canvas updates in real time.

### What Must Work After Phase 2

| Check | How to Verify |
|-------|---------------|
| MCP server starts | `node mcp-server/dist/index.js` prints "NNModelling MCP server listening on stdio" |
| MCP tools are listed | `ListTools` returns 40+ tools |
| `create_node` works | Calling `create_node` via MCP adds a node to DiagramCore and emits events |
| WebSocket broadcasts | Browser connects to `ws://localhost:9339` and receives delta messages |
| Browser auto-updates | Creating a node via MCP → node appears on canvas without reload |
| `compile_nntree` works | Compiles diagram → valid NNTree JSON |
| `execute_conversion` works | Generates Hydra YAML configs via `convert.py` |
| Full pipeline | Build MNIST classifier via MCP → compile → convert → train (1 epoch) |

---

## Step-by-Step Task List

### Step 0: Set Up pnpm Workspace

The project currently has `front-end/package.json` as the only package. We need to add `mcp-server/` as a second workspace package.

**File**: `pnpm-workspace.yaml` (root of NNModelling)

```yaml
packages:
  - "front-end"
  - "mcp-server"
```

**Verification**:
```bash
pnpm install  # Should resolve both packages
```

**Commit**: `git add pnpm-workspace.yaml && git commit -m "chore: add pnpm workspace for mcp-server"`

---

### Step 1: Scaffold `mcp-server/` Package

**File**: `mcp-server/package.json`

```json
{
  "name": "@nnmodelling/mcp-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "bin": {
    "nnmodelling-mcp": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node dist/index.js"
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

**File**: `mcp-server/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "__tests__"]
}
```

**File**: `mcp-server/vitest.config.ts`

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    globals: true,
    testTimeout: 30_000,   // 30s for tools that spawn subprocesses
  },
});
```

**Install dependencies**:
```bash
cd mcp-server && pnpm install
```

**Verification**: `pnpm run build` should compile (empty `src/` is fine).

**Commit**: `git add mcp-server/ && git commit -m "chore: scaffold mcp-server package"`

---

### Step 2: Implement Error Types

**File**: `mcp-server/src/errors.ts`

Define all error classes from the architecture document.

```typescript
export class MCPServerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "MCPServerError";
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

// ── Validation Errors ──────────────────────────
export class StereotypeNotFoundError extends MCPServerError {
  constructor(name: string) {
    super("STEREOTYPE_NOT_FOUND", `Stereotype '${name}' not found`, { stereotypeName: name });
  }
}

export class NodeNotFoundError extends MCPServerError {
  constructor(nodeId: string) {
    super("NODE_NOT_FOUND", `Node '${nodeId}' not found`, { nodeId });
  }
}

export class EdgeNotFoundError extends MCPServerError {
  constructor(edgeId: string) {
    super("EDGE_NOT_FOUND", `Edge '${edgeId}' not found`, { edgeId });
  }
}

export class ParameterNotFoundError extends MCPServerError {
  constructor(nodeId: string, key: string) {
    super("PARAMETER_NOT_FOUND", `Parameter '${key}' not found on node '${nodeId}'`, { nodeId, key });
  }
}

export class ParameterTypeMismatchError extends MCPServerError {
  constructor(nodeId: string, key: string, expected: string, received: string) {
    super("PARAMETER_TYPE_MISMATCH",
      `Parameter '${key}' on node '${nodeId}' expected type '${expected}', got '${received}'`,
      { nodeId, key, expected, received });
  }
}

export class TargetHandleOccupiedError extends MCPServerError {
  constructor(target: string, targetHandle: string) {
    super("TARGET_HANDLE_OCCUPIED",
      `Target handle '${targetHandle}' on node '${target}' is already connected`,
      { target, targetHandle });
  }
}

export class InvalidConnectionError extends MCPServerError {
  constructor(reason: string) {
    super("INVALID_CONNECTION", reason);
  }
}

export class SelfLoopError extends MCPServerError {
  constructor(nodeId: string) {
    super("SELF_LOOP", `Cannot connect node '${nodeId}' to itself`, { nodeId });
  }
}

export class CycleDetectedError extends MCPServerError {
  constructor(nodeId: string) {
    super("CYCLE_DETECTED", `Connection would create a cycle involving node '${nodeId}'`, { nodeId });
  }
}

export class InvalidPositionError extends MCPServerError {
  constructor(x: unknown, y: unknown) {
    super("INVALID_POSITION", `Invalid position: (${x}, ${y})`, { x, y });
  }
}

export class InvalidSubflowError extends MCPServerError {
  constructor(nodeId: string, reason: string) {
    super("INVALID_SUBFLOW", `Invalid subflow '${nodeId}': ${reason}`, { nodeId, reason });
  }
}

export class CompilationFailedError extends MCPServerError {
  constructor(reason: string) {
    super("COMPILATION_FAILED", reason);
  }
}

export class ConversionFailedError extends MCPServerError {
  constructor(reason: string) {
    super("CONVERSION_FAILED", reason);
  }
}

export class TrainingFailedError extends MCPServerError {
  constructor(reason: string) {
    super("TRAINING_FAILED", reason);
  }
}

export class InferenceFailedError extends MCPServerError {
  constructor(reason: string) {
    super("INFERENCE_FAILED", reason);
  }
}

// ── Transaction Errors ─────────────────────────
export class NoActiveTransactionError extends MCPServerError {
  constructor() {
    super("NO_ACTIVE_TRANSACTION", "No active transaction");
  }
}

export class TransactionAlreadyActiveError extends MCPServerError {
  constructor() {
    super("TRANSACTION_ALREADY_ACTIVE", "A transaction is already active");
  }
}

// ── History Errors ─────────────────────────────
export class NothingToUndoError extends MCPServerError {
  constructor() {
    super("NOTHING_TO_UNDO", "Nothing to undo");
  }
}

export class NothingToRedoError extends MCPServerError {
  constructor() {
    super("NOTHING_TO_REDO", "Nothing to redo");
  }

// ── Serialization Errors ───────────────────────
export class ImportFailedError extends MCPServerError {
  constructor(reason: string) {
    super("IMPORT_FAILED", reason);
  }
}

export class ExportFailedError extends MCPServerError {
  constructor(reason: string) {
    super("EXPORT_FAILED", reason);
  }
}
```

**Commit**: `git add mcp-server/src/errors.ts && git commit -m "feat(mcp): implement error type hierarchy"`

---

### Step 3: Implement Transaction Manager

**File**: `mcp-server/src/transaction.ts`

```typescript
import { DiagramCore, type DiagramCoreSnapshot } from "@nnmodelling/front-end/core/DiagramCore";
import { NoActiveTransactionError, TransactionAlreadyActiveError } from "./errors";

interface BufferedMutation {
  type: string;
  execute: () => void;
  undo?: () => void;
}

interface Transaction {
  id: string;
  label: string;
  snapshot: DiagramCoreSnapshot;
  mutations: BufferedMutation[];
}

export class TransactionManager {
  private active: Transaction | null = null;
  private diagram: DiagramCore;

  constructor(diagram: DiagramCore) {
    this.diagram = diagram;
  }

  begin(label: string): string {
    if (this.active) throw new TransactionAlreadyActiveError();
    this.active = {
      id: crypto.randomUUID(),
      label,
      snapshot: this.diagram.getSnapshot(),
      mutations: [],
    };
    return this.active.id;
  }

  buffer(mutation: BufferedMutation): void {
    if (!this.active) {
      // No active transaction: execute immediately
      mutation.execute();
      return;
    }
    this.active.mutations.push(mutation);
  }

  commit(): { transactionId: string; mutations: Array<{ type: string; summary: string }> } {
    if (!this.active) throw new NoActiveTransactionError();
    const tx = this.active;

    // Apply all buffered mutations
    for (const m of tx.mutations) {
      m.execute();
    }

    const summary = tx.mutations.map(m => ({
      type: m.type,
      summary: `${m.type}`,
    }));

    this.active = null;
    return { transactionId: tx.id, mutations: summary };
  }

  rollback(): { transactionId: string; discardedMutations: number } {
    if (!this.active) throw new NoActiveTransactionError();
    const tx = this.active;

    // Restore pre-transaction snapshot
    this.diagram.restoreSnapshot(tx.snapshot);

    const count = tx.mutations.length;
    this.active = null;
    return { transactionId: tx.id, discardedMutations: count };
  }

  isActive(): boolean {
    return this.active !== null;
  }

  getActiveId(): string | null {
    return this.active?.id ?? null;
  }
}
```

**Commit**: `git add mcp-server/src/transaction.ts && git commit -m "feat(mcp): implement TransactionManager"`

---

### Step 4: Implement History Manager

**File**: `mcp-server/src/history.ts`

Snapshot-based undo/redo (50-entry stack, ~5MB max memory).

```typescript
import { DiagramCore, type DiagramCoreSnapshot } from "@nnmodelling/front-end/core/DiagramCore";
import type { DiagramSnapshot } from "@nnmodelling/front-end/core/types";
import { NothingToUndoError, NothingToRedoError } from "./errors";

export class HistoryManager {
  private undoStack: DiagramSnapshot[] = [];
  private redoStack: DiagramSnapshot[] = [];
  private readonly maxDepth: number = 50;

  pushSnapshot(description: string, diagram: DiagramCore): void {
    const snapshot = diagram.getSnapshot();
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

  undo(diagram: DiagramCore): { undone: string; canUndo: boolean; canRedo: boolean } {
    if (this.undoStack.length === 0) throw new NothingToUndoError();

    // Save current state to redo stack
    const current = diagram.getSnapshot();
    this.redoStack.push({
      ...current,
      timestamp: Date.now(),
      description: "redo point",
    });

    // Pop and restore
    const snapshot = this.undoStack.pop()!;
    diagram.restoreSnapshot(snapshot);

    return {
      undone: snapshot.description,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  redo(diagram: DiagramCore): { redone: string; canUndo: boolean; canRedo: boolean } {
    if (this.redoStack.length === 0) throw new NothingToRedoError();

    const current = diagram.getSnapshot();
    this.undoStack.push({
      ...current,
      timestamp: Date.now(),
      description: "undo point",
    });

    const snapshot = this.redoStack.pop()!;
    diagram.restoreSnapshot(snapshot);

    return {
      redone: snapshot.description,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  getStatus(): { undoCount: number; redoCount: number; maxUndoDepth: number } {
    return {
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
      maxUndoDepth: this.maxDepth,
    };
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
```

**Commit**: `git add mcp-server/src/history.ts && git commit -m "feat(mcp): implement snapshot-based HistoryManager"`

---

### Step 5: Implement Python Pipeline Interface

**File**: `mcp-server/src/pipeline.ts`

Spawns Python subprocesses for conversion, training, and inference.

```typescript
import { spawn } from "child_process";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ConversionFailedError, TrainingFailedError, InferenceFailedError } from "./errors";

export interface ConversionOptions {
  outputDir: string;
  numClasses?: number;
  dataset?: string;
  earlyStopPatience?: number;
  earlyStopMinDelta?: number;
  maxEpochs?: number;
}

export interface ConversionResult {
  success: boolean;
  outputDir: string;
  taskType: string;
  numClasses: number | null;
  configFiles: string[];
}

export interface TrainingOptions {
  configDir: string;
  configName?: string;
  device?: "cpu" | "gpu";
  maxEpochs?: number;
}

export interface TrainingResult {
  success: boolean;
  checkpointPath: string | null;
  metrics: { trainLoss?: number; valLoss?: number; valAccuracy?: number };
  logPath: string;
  duration: number;
}

export interface InferenceOptions {
  configDir: string;
  configName?: string;
  weightsPath: string;
  outputPath?: string;
  imageDir?: string;
  device?: "cpu" | "gpu";
}

export interface InferenceResult {
  success: boolean;
  predictionsPath: string | null;
  imageDir: string | null;
  sampleCount: number;
  metrics: Record<string, number>;
}

function spawnPython(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("uv", ["run", "python", ...args], {
      cwd: join(process.cwd(), "..", "converted"),  // Relative to mcp-server/
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

export async function executeConversion(
  nntreeJson: string,
  options: ConversionOptions
): Promise<ConversionResult> {
  // Write NNTree JSON to temp file
  const tmpDir = mkdtempSync(join(tmpdir(), "nnmodelling-convert-"));
  const jsonPath = join(tmpDir, "nntree.json");

  try {
    writeFileSync(jsonPath, nntreeJson, "utf-8");

    const args = ["src/convert.py", jsonPath, options.outputDir];
    if (options.numClasses !== undefined) args.push("--num-classes", String(options.numClasses));
    if (options.dataset) args.push("--dataset", options.dataset);
    if (options.earlyStopPatience !== undefined) args.push("--early-stop-patience", String(options.earlyStopPatience));
    if (options.earlyStopMinDelta !== undefined) args.push("--early-stop-min-delta", String(options.earlyStopMinDelta));
    if (options.maxEpochs !== undefined) args.push("--max-epochs", String(options.maxEpochs));

    const { stdout, stderr, exitCode } = await spawnPython(args);

    if (exitCode !== 0) {
      throw new ConversionFailedError(stderr || `convert.py exited with code ${exitCode}`);
    }

    // Parse stdout for taskType
    const taskTypeMatch = stdout.match(/Detected task type: (\w+)/);
    const taskType = taskTypeMatch ? taskTypeMatch[1] : "unknown";

    // List generated config files
    const { readdirSync } = await import("fs");
    const configFiles: string[] = [];
    function walkDir(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walkDir(full);
        else if (entry.name.endsWith(".yaml")) configFiles.push(full);
      }
    }
    walkDir(options.outputDir);

    return {
      success: true,
      outputDir: options.outputDir,
      taskType,
      numClasses: options.numClasses ?? null,
      configFiles,
    };
  } finally {
    // Cleanup temp directory
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

export async function executeTraining(
  options: TrainingOptions
): Promise<TrainingResult> {
  const args = [
    "src/main.py",
    "--config-path", options.configDir,
    "--config-name", options.configName || "base",
  ];

  const startTime = Date.now();
  const { stdout, stderr, exitCode } = await spawnPython(args);
  const duration = (Date.now() - startTime) / 1000;

  if (exitCode !== 0) {
    throw new TrainingFailedError(stderr || `main.py exited with code ${exitCode}`);
  }

  // Attempt to find checkpoint
  const checkpointPath = join(options.configDir, "..", "weights.pt");

  return {
    success: true,
    checkpointPath,
    metrics: {},  // Parse from stdout if needed
    logPath: join(options.configDir, "..", "wandb"),
    duration,
  };
}

export async function executeInference(
  options: InferenceOptions
): Promise<InferenceResult> {
  const args = [
    "src/infer.py",
    "--config-path", options.configDir,
    "--config-name", options.configName || "base",
    "--weights", options.weightsPath,
  ];
  if (options.outputPath) args.push("--output", options.outputPath);
  if (options.imageDir) args.push("--image-dir", options.imageDir);
  if (options.device) args.push("--device", options.device);

  const { stdout, stderr, exitCode } = await spawnPython(args);

  if (exitCode !== 0) {
    throw new InferenceFailedError(stderr || `infer.py exited with code ${exitCode}`);
  }

  return {
    success: true,
    predictionsPath: options.outputPath ?? null,
    imageDir: options.imageDir ?? null,
    sampleCount: 0,   // Parse from stdout
    metrics: {},       // Parse from stdout
  };
}
```

**Commit**: `git add mcp-server/src/pipeline.ts && git commit -m "feat(mcp): implement Python pipeline subprocess interface"`

---

### Step 6: Implement MCP Tools

This is the largest step. We implement all tool groups as defined in the architecture document.

**File structure**:
```
mcp-server/src/tools/
├── graph.ts          # create_node, delete_nodes, connect_nodes, move_nodes, duplicate_nodes, align_nodes, distribute_nodes, create_subflow
├── parameters.ts     # set_parameter, update_parameters, reset_parameters, query_parameters
├── selection.ts      # select_nodes, select_all, clear_selection, get_selection
├── canvas.ts         # get_canvas_state, fit_view, center_view
├── validation.ts     # validate_graph, validate_connections, validate_parameters, validate_subflows
├── conversion.ts     # compile_nntree, export_diagram, import_diagram, execute_conversion, execute_training, execute_inference
├── inspection.ts     # get_graph, get_node, get_edges, get_subflow, graph_statistics, list_stereotypes
├── transaction.ts    # begin_transaction, commit, rollback
├── history.ts        # undo, redo, get_history_status
├── events.ts         # get_events
└── lifecycle.ts      # reset_diagram, ping
```

Each tool follows this pattern:
1. Zod schema for input validation
2. Async handler function that calls `DiagramCore` methods
3. Structured return value
4. Error wrapping in `MCPServerError` subtypes

**Key Design Pattern**: All tools receive a shared `ServerContext` object:

```typescript
// mcp-server/src/server.ts (defined later)
export interface ServerContext {
  diagram: DiagramCore;
  transactions: TransactionManager;
  history: HistoryManager;
  pipeline: PipelineModule;
  eventBuffer: DomainEvent[];
  lastEventCursor: number;
}
```

**Example: `tools/graph.ts` — `create_node`**:

```typescript
import { z } from "zod";
import type { ServerContext } from "../server";
import { StereotypeNotFoundError, InvalidPositionError } from "../errors";
import type { DomainEvent } from "@nnmodelling/front-end/core/types";

export const createNodeSchema = z.object({
  stereotype: z.string().min(1),
  position: z.object({
    x: z.number(),
    y: z.number(),
  }),
  config: z.object({
    name: z.string().optional(),
    color: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    params: z.record(z.string(), z.string()).optional(),
    inputsCount: z.number().int().min(1).optional(),
    parentId: z.string().optional(),
  }).optional(),
});

export async function createNode(
  ctx: ServerContext,
  input: z.infer<typeof createNodeSchema>
): Promise<{
  nodeId: string;
  name: string;
  type: string;
  stereotype: string;
}> {
  const { stereotype: stereotypeName, position, config } = input;

  // Find stereotype
  const stereotype = ctx.diagram.getStereotype(stereotypeName);
  if (!stereotype) throw new StereotypeNotFoundError(stereotypeName);

  // Validate position
  if (typeof position.x !== "number" || typeof position.y !== "number" || isNaN(position.x) || isNaN(position.y)) {
    throw new InvalidPositionError(position.x, position.y);
  }

  let node: import("@nnmodelling/front-end/core/types").Node;

  if (stereotype.isJoin) {
    node = ctx.diagram.addJoinNode(stereotype, position.x, position.y, {
      name: config?.name,
      color: config?.color,
      inputsCount: config?.inputsCount ?? 2,
      params: config?.params ?? {},
    });
  } else {
    node = ctx.diagram.addModule(stereotype, position.x, position.y, {
      name: config?.name,
      color: config?.color,
      width: config?.width,
      height: config?.height,
      params: config?.params ?? {},
    });
  }

  return {
    nodeId: node.id,
    name: (node.data as any)?.name ?? stereotypeName,
    type: node.type ?? "custom",
    stereotype: stereotypeName,
  };
}
```

**All other tools follow the same pattern.** The full list of tool names and their schemas is defined in the architecture document (§6). Each tool file exports:
- A Zod schema (for registering with MCP `ListTools`)
- A handler function (for MCP `CallTool`)

**Commit pattern**: One commit per tool file or logical group.

```
git add mcp-server/src/tools/graph.ts && git commit -m "feat(mcp): implement graph manipulation tools"
git add mcp-server/src/tools/parameters.ts && git commit -m "feat(mcp): implement parameter tools"
git add mcp-server/src/tools/selection.ts && git commit -m "feat(mcp): implement selection tools"
git add mcp-server/src/tools/canvas.ts && git commit -m "feat(mcp): implement canvas tools"
git add mcp-server/src/tools/validation.ts && git commit -m "feat(mcp): implement validation tools"
git add mcp-server/src/tools/conversion.ts && git commit -m "feat(mcp): implement conversion tools"
git add mcp-server/src/tools/inspection.ts && git commit -m "feat(mcp): implement inspection tools"
git add mcp-server/src/tools/transaction.ts && git commit -m "feat(mcp): implement transaction tools"
git add mcp-server/src/tools/history.ts && git commit -m "feat(mcp): implement history tools"
git add mcp-server/src/tools/events.ts && git commit -m "feat(mcp): implement event tools"
git add mcp-server/src/tools/lifecycle.ts && git commit -m "feat(mcp): implement lifecycle tools"
```

---

### Step 7: Implement MCP Resources

**File**: `mcp-server/src/resources/index.ts`

MCP resources are read-only views. Each resource definition includes a URI template, name, description, MIME type, and a read handler.

```typescript
import type { ServerContext } from "../server";

export function defineResources(ctx: ServerContext) {
  return [
    {
      uri: "nnmodelling://diagram/current",
      name: "Current Diagram",
      description: "Full diagram state (nodes, edges, statistics)",
      mimeType: "application/json",
      async read() {
        return {
          contents: [{
            uri: "nnmodelling://diagram/current",
            mimeType: "application/json",
            text: JSON.stringify({
              nodes: ctx.diagram.nodes,
              edges: ctx.diagram.edges,
            }, null, 2),
          }],
        };
      },
    },
    {
      uri: "nnmodelling://node/{id}",
      name: "Node by ID",
      description: "Get a single node by its ID",
      mimeType: "application/json",
      async read(uri: URL) {
        const nodeId = uri.pathname.split("/").pop()!;
        const node = ctx.diagram.getNodeById(nodeId);
        if (!node) throw new Error(`Node ${nodeId} not found`);
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(node, null, 2),
          }],
        };
      },
    },
    // ... remaining resources (stereotypes, validation, conversion, etc.)
  ];
}
```

**Commit**: `git add mcp-server/src/resources/ && git commit -m "feat(mcp): implement MCP resource definitions"`

---

### Step 8: Implement MCP Server Bootstrap

**File**: `mcp-server/src/server.ts`

This is the main server setup: creates `DiagramCore`, loads stereotypes, registers all tools and resources, and starts the MCP stdio transport.

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DiagramCore } from "@nnmodelling/front-end/core/DiagramCore";
import { StereotypeCore } from "@nnmodelling/front-end/core/StereotypeCore";
import { TransactionManager } from "./transaction";
import { HistoryManager } from "./history";
import * as pipelineMod from "./pipeline";
import { defineResources } from "./resources/index";

// Import all tool modules
import * as graphTools from "./tools/graph";
import * as paramTools from "./tools/parameters";
import * as selectionTools from "./tools/selection";
import * as canvasTools from "./tools/canvas";
import * as validationTools from "./tools/validation";
import * as conversionTools from "./tools/conversion";
import * as inspectionTools from "./tools/inspection";
import * as txnTools from "./tools/transaction";
import * as historyTools from "./tools/history";
import * as eventTools from "./tools/events";
import * as lifecycleTools from "./tools/lifecycle";

export interface ServerContext {
  diagram: DiagramCore;
  transactions: TransactionManager;
  history: HistoryManager;
  pipeline: typeof pipelineMod;
  eventBuffer: import("@nnmodelling/front-end/core/types").DomainEvent[];
  lastEventCursor: number;
}

export async function createServer(stereotypesDir: string): Promise<{ server: Server; ctx: ServerContext }> {
  // Initialize DiagramCore with Node.js stereotype loader
  const diagram = new DiagramCore();
  const stereotypes = StereotypeCore.loadFromDirectoryNode(stereotypesDir);
  diagram.initStereotypes(stereotypes);

  // Subscribe DiagramCore's EventBus to our event buffer (for MCP get_events)
  const eventBuffer: import("@nnmodelling/front-end/core/types").DomainEvent[] = [];
  diagram.events.onAny((event) => {
    eventBuffer.push(event);
    if (eventBuffer.length > 1000) eventBuffer.shift();
  });

  const ctx: ServerContext = {
    diagram,
    transactions: new TransactionManager(diagram),
    history: new HistoryManager(),
    pipeline: pipelineMod,
    eventBuffer,
    lastEventCursor: 0,
  };

  const server = new Server(
    { name: "nnmodelling-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  // ── Register all tools ──────────────────────
  const toolRegistry = new Map<string, { schema: any; handler: Function }>();

  const register = (tools: Record<string, { schema: any; handler: Function }>) => {
    for (const [name, tool] of Object.entries(tools)) {
      toolRegistry.set(name, tool);
    }
  };

  register(graphTools as any);
  register(paramTools as any);
  register(selectionTools as any);
  register(canvasTools as any);
  register(validationTools as any);
  register(conversionTools as any);
  register(inspectionTools as any);
  register(txnTools as any);
  register(historyTools as any);
  register(eventTools as any);
  register(lifecycleTools as any);

  // ListTools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(toolRegistry.entries()).map(([name, tool]) => ({
      name,
      description: `NNModelling tool: ${name}`,
      inputSchema: tool.schema,
    })),
  }));

  // CallTool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolRegistry.get(request.params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    try {
      const result = await tool.handler(ctx, request.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      const error = err.code
        ? err  // MCPServerError
        : { code: "INTERNAL_ERROR", message: err.message || "Unknown error" };

      return {
        content: [{ type: "text", text: JSON.stringify({ error }) }],
        isError: true,
      };
    }
  });

  // Resources
  const resources = defineResources(ctx);
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.map(r => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = new URL(request.params.uri);
    for (const resource of resources) {
      // Simple pattern matching (in production, use a proper router)
      if (resource.uri.replace(/\{id\}/g, "([^/]+)") === request.params.uri || resource.uri === request.params.uri) {
        return await resource.read(uri);
      }
    }
    throw new Error(`Resource not found: ${request.params.uri}`);
  });

  return { server, ctx };
}
```

**File**: `mcp-server/src/index.ts` — Entry point

```typescript
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "path";
import { createServer } from "./server";

async function main() {
  // Resolve the Stereotypes directory relative to the project root
  // In development: mcp-server/../Stereotypes/
  // In production: depends on install location
  const stereotypesDir = resolve(process.cwd(), "..", "Stereotypes");

  const { server } = await createServer(stereotypesDir);
  const transport = new StdioServerTransport();

  console.error("[nnmodelling-mcp] Starting server...");
  console.error(`[nnmodelling-mcp] Stereotypes dir: ${stereotypesDir}`);

  await server.connect(transport);

  console.error("[nnmodelling-mcp] Server connected via stdio");
}

main().catch((err) => {
  console.error("[nnmodelling-mcp] Fatal error:", err);
  process.exit(1);
});
```

**Verification**: `pnpm run build` compiles without errors.

**Commit**: `git add mcp-server/src/server.ts mcp-server/src/index.ts && git commit -m "feat(mcp): implement MCP server bootstrap with tool registration"`

---

### Step 9: Implement WebSocket Server

**File**: `mcp-server/src/ws-server.ts`

The WebSocket server subscribes to `EventBus.onAny()` and broadcasts delta messages to connected browsers.

```typescript
import { WebSocketServer, WebSocket } from "ws";
import type { EventBus } from "@nnmodelling/front-end/core/EventBus";
import type { DiagramCore } from "@nnmodelling/front-end/core/DiagramCore";
import type { DomainEvent, DeltaOperation, WSDeltaMessage, WSSnapshotMessage } from "@nnmodelling/front-end/core/types";

export interface WSServerConfig {
  port: number;
  host?: string;
}

export function createWSServer(
  diagram: DiagramCore,
  eventBus: EventBus,
  config: WSServerConfig
): WebSocketServer {
  const wss = new WebSocketServer({ port: config.port, host: config.host ?? "localhost" });

  console.error(`[nnmodelling-ws] WebSocket server listening on ws://${config.host ?? "localhost"}:${config.port}`);

  wss.on("connection", (ws: WebSocket) => {
    console.error(`[nnmodelling-ws] Browser connected (total: ${wss.clients.size})`);

    // Send full snapshot as first message
    const snapshot: WSSnapshotMessage = {
      type: "snapshot",
      seq: eventBus.getCurrentSeq(),
      nodes: diagram.nodes,
      edges: diagram.edges,
    };
    ws.send(JSON.stringify(snapshot));

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "request_snapshot") {
          const snap: WSSnapshotMessage = {
            type: "snapshot",
            seq: eventBus.getCurrentSeq(),
            nodes: diagram.nodes,
            edges: diagram.edges,
          };
          ws.send(JSON.stringify(snap));
        }
      } catch {}
    });

    ws.on("close", () => {
      console.error(`[nnmodelling-ws] Browser disconnected (total: ${wss.clients.size})`);
    });
  });

  // Subscribe to EventBus and broadcast deltas
  eventBus.onAny((event: DomainEvent) => {
    const operations = domainEventToDeltaOps(event);
    if (operations.length === 0) return;

    const delta: WSDeltaMessage = {
      type: "delta",
      seq: event.seq,
      operations,
    };

    const payload = JSON.stringify(delta);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  });

  return wss;
}

/**
 * Convert a DomainEvent to an array of DeltaOperations.
 * Some events map to multiple operations (e.g., node_deleted also removes attached edges).
 */
function domainEventToDeltaOps(event: DomainEvent): DeltaOperation[] {
  const p = event.payload as any;

  switch (event.type) {
    case "node_created":
      return [{ op: "node_added", nodeId: p.nodeId, data: p }];

    case "node_deleted":
      return [
        ...(p.edgeIds || []).map((eid: string) => ({ op: "edge_removed" as const, edgeId: eid })),
        ...p.nodeIds.map((nid: string) => ({ op: "node_removed" as const, nodeId: nid })),
      ];

    case "node_updated":
      return [{ op: "node_updated", nodeId: p.nodeId, changes: p.changes ?? {} }];

    case "node_moved":
      return [{ op: "node_moved", nodeId: p.nodeId, position: p.position }];

    case "edge_created":
      return [{ op: "edge_added", edgeId: p.edgeId, data: p }];

    case "edge_deleted":
      return p.edgeIds.map((eid: string) => ({ op: "edge_removed" as const, edgeId: eid }));

    case "edge_reconnected":
      return [{ op: "edge_reconnected", edgeId: p.edgeId, changes: p }];

    case "selection_changed":
      return [{ op: "selection_changed", nodeIds: p.nodeIds ?? [], edgeIds: p.edgeIds ?? [] }];

    case "graph_changed":
      return [];  // Graph-level change is implicit in other events

    case "subflow_toggled":
      return [{ op: "node_updated", nodeId: p.nodeId, changes: { hidden: p.collapsed } }];

    case "diagram_reset":
    case "diagram_imported":
      return [{ op: "graph_reset", nodes: p.nodes ?? [], edges: p.edges ?? [] }];

    default:
      return [];
  }
}
```

**Update `mcp-server/src/index.ts`** to start the WebSocket server alongside the MCP server:

```typescript
// Add after "await server.connect(transport);"
import { createWSServer } from "./ws-server";
const wsPort = parseInt(process.env.NNM_WS_PORT || "9339", 10);
const wss = createWSServer(ctx.diagram, ctx.diagram.events, { port: wsPort });

// Graceful shutdown
process.on("SIGTERM", () => {
  wss.close();
  process.exit(0);
});
```

**Commit**: `git add mcp-server/src/ws-server.ts && git commit -m "feat(mcp): implement WebSocket delta broadcaster"`

---

### Step 10: Implement Browser Sync Client

**File**: `front-end/src/sync/DiagramSyncClient.ts`

The browser-side WebSocket client that receives delta messages and applies them to the reactive `$state.raw` arrays.

Implementation exactly as designed in the architecture document (§4.6). Key points:
- Connects to `ws://localhost:9339` (or proxied `/ws` path in dev)
- On `"snapshot"` message: replaces `diagram.nodes` and `diagram.edges`
- On `"delta"` message: applies each `DeltaOperation` to the arrays
- Tracks `lastSeenSeq` for gap detection
- Auto-reconnects with exponential backoff (1s → 1.5s → 2.25s → ... → 30s max)
- On sequence gap: sends `{"type":"request_snapshot"}` to trigger full state sync

**Integration with `FlowCanvas.svelte`** (lines 42 area):

```svelte
<script lang="ts">
  import { DiagramSyncClient } from "./sync/DiagramSyncClient";

  // After: const diagram = new Diagram();
  let syncClient: DiagramSyncClient;

  $effect(() => {
    syncClient = new DiagramSyncClient(diagram);
    syncClient.connect();
    return () => syncClient.disconnect();
  });
</script>
```

**Commit**: `git add front-end/src/sync/DiagramSyncClient.ts && git commit -m "feat(sync): implement browser WebSocket sync client"`
`git add front-end/src/FlowCanvas.svelte && git commit -m "feat(sync): integrate DiagramSyncClient into FlowCanvas"`

---

### Step 11: Configure Vite Proxy for WebSocket

**File**: `front-end/vite.config.ts`

Add a WebSocket proxy so the dev server forwards `/ws` to the MCP server:

```typescript
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [
    svelte({ emitCss: false }),
  ],
  server: {
    proxy: {
      "/ws": {
        target: "ws://localhost:9339",
        ws: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ["@xyflow/svelte"],
  },
});
```

This allows `DiagramSyncClient` to connect to `ws://localhost:5173/ws` in dev mode, which Vite proxies to `ws://localhost:9339`. In production, the client connects directly to the MCP server's WebSocket port.

**Update `DiagramSyncClient`** to use the proxied URL in dev:

```typescript
// In DiagramSyncClient constructor:
const wsUrl = import.meta.env.DEV
  ? `ws://${window.location.host}/ws`   // Proxied through Vite
  : `ws://localhost:9339`;               // Direct in production
```

**Commit**: `git add front-end/vite.config.ts && git commit -m "feat(vite): proxy /ws to MCP server WebSocket port"`

---

### Step 12: Implement MCP Integration Tests

**File**: `mcp-server/__tests__/tools.test.ts`

Test each tool in isolation with a mocked or real `DiagramCore` instance.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { DiagramCore } from "@nnmodelling/front-end/core/DiagramCore";
import { StereotypeCore } from "@nnmodelling/front-end/core/StereotypeCore";
import { createNode } from "../src/tools/graph";
import type { ServerContext } from "../src/server";

describe("create_node", () => {
  let diagram: DiagramCore;
  let ctx: ServerContext;

  beforeEach(() => {
    diagram = new DiagramCore();
    // Load stereotypes from the project's Stereotypes/ directory
    const stereotypesDir = require("path").resolve(__dirname, "../../../Stereotypes");
    diagram.initStereotypes(StereotypeCore.loadFromDirectoryNode(stereotypesDir));

    ctx = {
      diagram,
      transactions: null as any,  // Will be set up if needed
      history: null as any,
      pipeline: null as any,
      eventBuffer: [],
      lastEventCursor: 0,
    };
  });

  it("creates a Linear node", async () => {
    const result = await createNode(ctx, {
      stereotype: "Linear",
      position: { x: 100, y: 50 },
      config: { params: { in_features: "784", out_features: "128" } },
    });

    expect(result.nodeId).toBeTruthy();
    expect(result.type).toBe("custom");
    expect(result.stereotype).toBe("Linear");

    const node = diagram.getNodeById(result.nodeId);
    expect(node).toBeTruthy();
    expect(node!.position).toEqual({ x: 100, y: 50 });
  });

  it("throws on unknown stereotype", async () => {
    await expect(createNode(ctx, {
      stereotype: "NonExistentLayer",
      position: { x: 0, y: 0 },
    })).rejects.toThrow("STEREOTYPE_NOT_FOUND");
  });
});
```

**File**: `mcp-server/__tests__/websocket.test.ts`

Test WebSocket server integration:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DiagramCore } from "@nnmodelling/front-end/core/DiagramCore";
import { StereotypeCore } from "@nnmodelling/front-end/core/StereotypeCore";
import { createWSServer } from "../src/ws-server";
import WebSocket from "ws";

describe("WebSocket Server", () => {
  let diagram: DiagramCore;
  let wss: ReturnType<typeof createWSServer>;
  const PORT = 19339;  // Test port

  beforeAll(async () => {
    diagram = new DiagramCore();
    const stereotypesDir = require("path").resolve(__dirname, "../../../Stereotypes");
    diagram.initStereotypes(StereotypeCore.loadFromDirectoryNode(stereotypesDir));
    wss = createWSServer(diagram, diagram.events, { port: PORT });
  });

  afterAll(() => {
    wss.close();
  });

  it("sends snapshot on connect", async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);

    const msg: any = await new Promise((resolve) => {
      ws.on("message", (data) => resolve(JSON.parse(data.toString())));
    });

    expect(msg.type).toBe("snapshot");
    expect(msg.nodes).toBeDefined();
    expect(msg.edges).toBeDefined();
    expect(typeof msg.seq).toBe("number");

    ws.close();
  });

  it("broadcasts delta when node is created", async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);

    // Skip the snapshot
    await new Promise((resolve) => ws.once("message", resolve));

    // Create a node (this emits node_created → delta broadcast)
    const stereo = diagram.getStereotype("ReLU");
    diagram.addModule(stereo!, 50, 50);

    const deltaMsg: any = await new Promise((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "delta") resolve(msg);
      });
    });

    expect(deltaMsg.type).toBe("delta");
    expect(deltaMsg.operations.length).toBeGreaterThan(0);
    expect(deltaMsg.operations[0].op).toBe("node_added");

    ws.close();
  });
});
```

**Commit**: `git add mcp-server/__tests__/ && git commit -m "test(mcp): add tool and WebSocket integration tests"`

---

### Step 13: Full Integration Smoke Test

**Manual test script** — verify the complete pipeline works:

```bash
# Terminal 1: Start MCP server
cd mcp-server && pnpm run build && node dist/index.js
# Expected: [nnmodelling-mcp] Starting server...
# Expected: [nnmodelling-ws] WebSocket server listening on ws://localhost:9339
# Expected: [nnmodelling-mcp] Server connected via stdio

# Terminal 2: Start frontend dev server
cd front-end && npm run dev
# Open browser → http://localhost:5173
# Expected: Input node appears, WebSocket connection established (check dev tools Network tab)

# Terminal 3: Simulate LLM agent calls via MCP inspector or a test script
# (In production, this would be Claude Desktop or similar)
node -e "
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
// ... connect to MCP server, call create_node, verify browser updates
"
```

**Automated integration test** (Vitest):

```typescript
// mcp-server/__tests__/integration.test.ts
import { describe, it, expect } from "vitest";
import { DiagramCore } from "@nnmodelling/front-end/core/DiagramCore";
import { StereotypeCore } from "@nnmodelling/front-end/core/StereotypeCore";
import { NNTree } from "@nnmodelling/front-end/conversion/nnTree";

describe("Full pipeline", () => {
  it("builds MNIST classifier diagram and compiles to NNTree", () => {
    const diagram = new DiagramCore();
    const stereotypesDir = require("path").resolve(__dirname, "../../../Stereotypes");
    diagram.initStereotypes(StereotypeCore.loadFromDirectoryNode(stereotypesDir));

    // Build the graph programmatically (same as MCP create_node calls)
    const inputStereo = diagram.getStereotype("Input")!;
    const linearStereo = diagram.getStereotype("Linear")!;
    const reluStereo = diagram.getStereotype("ReLU")!;
    const ceStereo = diagram.getStereotype("CrossEntropyLoss")!;

    const input = diagram.addModule(inputStereo, 200, 50);
    const lin1 = diagram.addModule(linearStereo, 200, 150, {
      params: { in_features: { value: "784" }, out_features: { value: "128" } },
    });
    const relu = diagram.addModule(reluStereo, 200, 250);
    const lin2 = diagram.addModule(linearStereo, 200, 350, {
      params: { in_features: { value: "128" }, out_features: { value: "10" } },
    });
    const loss = diagram.addModule(ceStereo, 200, 450);

    diagram.addEdge(input.id, lin1.id);
    diagram.addEdge(lin1.id, relu.id);
    diagram.addEdge(relu.id, lin2.id);
    diagram.addEdge(lin2.id, loss.id);

    // Compile
    const nntree = new NNTree(diagram);
    const json = nntree.toJson();
    const parsed = JSON.parse(json);

    expect(parsed.root).toBeTruthy();
    expect(parsed.lossNode).toBeTruthy();
    expect(parsed.lossNode.stereotype).toBe("CrossEntropyLoss");
  });
});
```

**Commit**: `git add mcp-server/__tests__/integration.test.ts && git commit -m "test(mcp): add full pipeline integration test"`

---

### Step 14: Run Full Test Suite

```bash
# MCP server tests
cd mcp-server && pnpm run test

# Frontend unit tests (should still pass)
cd ../front-end && npm run test

# Frontend integration tests (Tier 1 — convert)
npm run test:integration:convert

# Type checking
cd ../front-end && npm run check
cd ../mcp-server && pnpm run build
```

**Final manual verification**:
1. Start MCP server: `cd mcp-server && node dist/index.js`
2. Start dev server: `cd front-end && npm run dev`
3. Open `http://localhost:5173` — Input node visible
4. Send a test MCP call (via MCP Inspector or a test script)
5. Verify new node appears on canvas without reload

**Tag**: `git tag phase2-complete`

---

## Files Created (Phase 2)

```
nnmodelling/
├── pnpm-workspace.yaml
│
├── mcp-server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   └── src/
│       ├── index.ts                  # Entry point
│       ├── server.ts                 # MCP server bootstrap + tool registration
│       ├── ws-server.ts              # WebSocket delta broadcaster
│       ├── errors.ts                 # Error type hierarchy
│       ├── transaction.ts            # TransactionManager
│       ├── history.ts                # HistoryManager (undo/redo)
│       ├── pipeline.ts               # Python subprocess interface
│       ├── resources/
│       │   └── index.ts              # MCP resource definitions
│       └── tools/
│           ├── graph.ts              # create_node, delete_nodes, connect_nodes, ...
│           ├── parameters.ts         # set_parameter, update_parameters, ...
│           ├── selection.ts          # select_nodes, clear_selection, ...
│           ├── canvas.ts             # get_canvas_state, fit_view, center_view
│           ├── validation.ts         # validate_graph, validate_connections, ...
│           ├── conversion.ts         # compile_nntree, execute_conversion, ...
│           ├── inspection.ts         # get_graph, get_node, get_edges, ...
│           ├── transaction.ts        # begin_transaction, commit, rollback
│           ├── history.ts            # undo, redo, get_history_status
│           ├── events.ts             # get_events
│           └── lifecycle.ts          # reset_diagram, ping
│
├── front-end/src/sync/
│   └── DiagramSyncClient.ts          # Browser WebSocket sync client
```

## Files Modified (Phase 2)

```
front-end/
├── vite.config.ts                    # Added /ws proxy
├── src/FlowCanvas.svelte             # Added DiagramSyncClient integration
└── src/sync/DiagramSyncClient.ts     # (new file, listed above)
```

---

## Dependency Graph for Phase 2

```
Step 0: pnpm-workspace.yaml      (no deps)
Step 1: mcp-server scaffold      → Step 0
Step 2: errors.ts                → Step 1
Step 3: transaction.ts           → Step 2 (+ DiagramCore from Phase 1)
Step 4: history.ts               → Step 2 (+ DiagramCore from Phase 1)
Step 5: pipeline.ts              → Step 2
Steps 2-5 can be done in parallel

Step 6: tools/*.ts               → Steps 2,3,4,5 (all need errors, some need transaction/history/pipeline)
Step 7: resources/index.ts       → Step 6
Step 8: server.ts, index.ts      → Steps 6,7
Step 9: ws-server.ts             → Step 8 (+ EventBus from Phase 1)
Step 10: sync/DiagramSyncClient.ts → Step 9 (needs WS protocol types)
Step 11: vite.config.ts update    → Step 10
Step 12: __tests__/*.ts           → Steps 6-10
Step 13: integration smoke       → Step 12
Step 14: full test suite         → Step 13
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| `@nnmodelling/front-end` workspace import doesn't resolve | Ensure `front-end/package.json` has `"name": "@nnmodelling/front-end"` (rename from current `"vite-svelte-flow-template"`). Add `"exports"` field pointing to `src/`. |
| `fs` / `path` module resolution in tests | Vitest runs in Node.js by default; `require("fs")` works. For browser tests, those code paths are not executed. |
| MCP `@modelcontextprotocol/sdk` API mismatch | Pin to exact version. Check SDK changelog. The API used here (`Server`, `StdioServerTransport`, `CallToolRequestSchema`, etc.) is stable in v1.x. |
| WebSocket port conflict | Default: 9339. Make configurable via `NNM_WS_PORT` env var. The `vite.config.ts` proxy target must match. |
| Python `uv run python` path resolution | The `pipeline.ts` assumes `converted/` is at `mcp-server/../converted/`. In a monorepo, this is correct. Make the path configurable via env var `NNM_PYTHON_DIR`. |
| Browser doesn't connect to WebSocket | Check CORS (WebSocket doesn't enforce same-origin by default). Check that vite proxy `ws: true` is set. Verify the MCP server is running and listening on the correct port. |

---

## Checkpoint Summary

| Step | What | Verification | Commit |
|------|------|-------------|--------|
| 0 | pnpm workspace | `pnpm install` | `chore: add pnpm workspace for mcp-server` |
| 1 | Scaffold mcp-server | `pnpm run build` | `chore: scaffold mcp-server package` |
| 2 | Error types | Compiles | `feat(mcp): implement error type hierarchy` |
| 3 | TransactionManager | Compiles | `feat(mcp): implement TransactionManager` |
| 4 | HistoryManager | Compiles | `feat(mcp): implement snapshot-based HistoryManager` |
| 5 | Python pipeline | Compiles | `feat(mcp): implement Python pipeline subprocess interface` |
| 6 | All tools (11 files) | Compiles | 11 commits (one per tool file) |
| 7 | MCP resources | Compiles | `feat(mcp): implement MCP resource definitions` |
| 8 | Server bootstrap | `pnpm run build` | `feat(mcp): implement MCP server bootstrap` |
| 9 | WebSocket server | Compiles | `feat(mcp): implement WebSocket delta broadcaster` |
| 10 | Browser sync client | Compiles | `feat(sync): implement browser WebSocket sync client` |
| 11 | Vite proxy | Dev server starts | `feat(vite): proxy /ws to MCP server WebSocket port` |
| 12 | Integration tests | `pnpm run test` (mcp-server) | `test(mcp): add tool and WebSocket integration tests` |
| 13 | Full pipeline test | All tests pass | `test(mcp): add full pipeline integration test` |
| 14 | Final verification | Manual + automated | Tag: `phase2-complete` |
