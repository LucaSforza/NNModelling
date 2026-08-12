# Phase 3: Rewrite MCP Tools as Thin Browser-RPC Proxies

## Objective
Transform every MCP tool handler from direct `DiagramCore` manipulation into a thin browser RPC call. Remove tools that depended on server-side state (transaction, history, events). Remove all 14 MCP resources.

## ServerContext Changes

```typescript
// OLD:
export interface ServerContext {
  diagram: DiagramCore;
  transactions: TransactionManager;
  history: HistoryManager;
  pipeline: typeof pipelineMod;
  eventBuffer: DomainEvent[];
  lastEventCursor: number;
}

// NEW:
export interface ServerContext {
  browser: BrowserRPCClient;
  pipeline: typeof pipelineMod;
  stereotypes: StereotypeCore[];  // static, for list_stereotypes fallback
}
```

## Tool Pattern (every tool follows this template)

```typescript
export const tool_name = {
  schema: z.object({ /* input schema unchanged */ }),
  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("rpc_method_name", input);
  },
};
```

## Files to Modify

| File | Action | Details |
|---|---|---|
| `tools/graph.ts` | **REWRITE** | 8 tools → thin proxies calling browser RPC |
| `tools/parameters.ts` | **REWRITE** | 4 tools → thin proxies |
| `tools/selection.ts` | **REWRITE** | 4 tools → thin proxies |
| `tools/inspection.ts` | **REWRITE** | 6 tools → thin proxies |
| `tools/validation.ts` | **REWRITE** | 4 tools → thin proxies (simplified) |
| `tools/conversion.ts` | **REWRITE** | 6 tools → thin proxies (pipeline tools stay server-side) |
| `tools/canvas.ts` | **REWRITE** | 3 tools → real browser calls (was stubs) |
| `tools/lifecycle.ts` | **REWRITE** | 2 tools → thin proxies |
| `tools/transaction.ts` | **DELETE** | No TransactionManager |
| `tools/history.ts` | **DELETE** | No HistoryManager |
| `tools/events.ts` | **DELETE** | No EventBus |
| `resources/index.ts` | **DELETE** | All 14 resources removed |
| `server.ts` | **REWRITE** | Simplified (see Phase 4) |

## Tool → RPC Method Mapping

Each tool maps to a browser RPC method name:

| Tool | RPC Method | Server-Side Logic? |
|---|---|---|
| `create_node` | `"create_node"` | No |
| `delete_nodes` | `"delete_nodes"` | No |
| `connect_nodes` | `"connect_nodes"` | No |
| `disconnect_nodes` | `"disconnect_nodes"` | No |
| `move_nodes` | `"move_nodes"` | No |
| `duplicate_nodes` | `"duplicate_nodes"` | No |
| `create_subflow` | `"create_subflow"` | No |
| `set_parameter` | `"set_parameter"` | No |
| `update_parameters` | `"update_parameters"` | No |
| `reset_parameters` | `"reset_parameters"` | No |
| `query_parameters` | `"query_parameters"` | No |
| `select_nodes` | `"select_nodes"` | No |
| `clear_selection` | `"clear_selection"` | No |
| `get_selection` | `"get_selection"` | No |
| `select_all` | `"select_all"` | No |
| `get_graph` | `"get_graph"` | No |
| `get_node` | `"get_node"` | No |
| `get_edges` | `"get_edges"` | No |
| `get_subflow` | `"get_subflow"` | No |
| `graph_statistics` | `"graph_statistics"` | No |
| `list_stereotypes` | `"list_stereotypes"` | Can use server-side `ctx.stereotypes` cache |
| `validate_graph` | `"validate_graph"` | No |
| `validate_connections` | `"validate_connections"` | No |
| `validate_parameters` | `"validate_parameters"` | No |
| `validate_subflows` | `"validate_subflows"` | No |
| `compile_nntree` | `"compile_nntree"` | No (browser runs NNTree) |
| `export_diagram` | `"export_diagram"` | No |
| `import_diagram` | `"import_diagram"` | No |
| `execute_conversion` | `"compile_nntree"` (query) | **Yes**: gets JSON from browser, writes temp file, runs `convert.py` |
| `execute_training` | — | **Yes**: runs `main.py` (server-side only) |
| `execute_inference` | — | **Yes**: runs `infer.py` (server-side only) |
| `reset_diagram` | `"reset_diagram"` | No |
| `ping` | `"ping"` | No |
| `get_canvas_state` | `"get_canvas_state"` | No (browser now provides real data) |
| `fit_view` | `"fit_view"` | No (browser executes SvelteFlow fitView) |
| `center_view` | `"center_view"` | No (browser executes SvelteFlow setCenter) |

## Spec for Each Rewritten Tool File

### tools/graph.ts (8 tools → thin proxies)

```typescript
import { z } from "zod";
import type { ServerContext } from "../server";

export const create_node = {
  schema: z.object({
    stereotype: z.string().min(1),
    position: z.object({ x: z.number(), y: z.number() }),
    config: z.object({
      name: z.string().optional(),
      color: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      params: z.record(z.string(), z.string()).optional(),
      inputsCount: z.number().int().min(1).optional(),
      parentId: z.string().optional(),
    }).optional(),
  }),
  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("create_node", input);
  },
};

export const delete_nodes = {
  schema: z.object({ nodeIds: z.array(z.string()).min(1) }),
  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("delete_nodes", input);
  },
};

export const connect_nodes = {
  schema: z.object({
    source: z.string().min(1),
    target: z.string().min(1),
    sourceHandle: z.string().optional(),
    targetHandle: z.string().optional(),
  }),
  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("connect_nodes", input);
  },
};

export const disconnect_nodes = {
  schema: z.object({
    source: z.string().min(1),
    target: z.string().min(1),
    targetHandle: z.string().optional(),
  }),
  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("disconnect_nodes", input);
  },
};

export const move_nodes = {
  schema: z.object({
    positions: z.array(z.object({ id: z.string(), x: z.number(), y: z.number() })).min(1),
  }),
  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("move_nodes", input);
  },
};

export const duplicate_nodes = {
  schema: z.object({
    nodeIds: z.array(z.string()).min(1),
    offset: z.object({ x: z.number(), y: z.number() }).optional(),
  }),
  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("duplicate_nodes", input);
  },
};

export const create_subflow = {
  schema: z.object({
    position: z.object({ x: z.number(), y: z.number() }),
    label: z.string().optional(),
  }),
  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("create_subflow", input);
  },
};
```

### tools/parameters.ts (4 tools → thin proxies)

Same pattern — each handler becomes `return ctx.browser.call("method_name", input);`

### tools/selection.ts (4 tools → thin proxies)

Same pattern.

### tools/inspection.ts (6 tools → thin proxies)

`list_stereotypes` can optionally use `ctx.stereotypes` cache if browser not connected:

```typescript
export const list_stereotypes = {
  schema: z.object({ category: z.string().optional() }),
  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    // Try browser first; fall back to server-side cache
    if (ctx.browser.isConnected()) {
      try { return await ctx.browser.call("list_stereotypes", input); } catch {}
    }
    const filtered = input.category
      ? ctx.stereotypes.filter(s => s.category === input.category)
      : ctx.stereotypes;
    return {
      stereotypes: filtered.map(s => ({
        name: s.name, category: s.category, pythonClassName: s.pythonClassName,
        isJoin: s.isJoin, isInput: s.isInput, isLoss: s.isLoss,
        isSubFlow: s.isSubFlow, parameters: s.parameters,
      })),
    };
  },
};
```

### tools/validation.ts (4 tools → thin proxies)

Simplify the huge validation file — each handler becomes:

```typescript
export const validate_graph = {
  schema: z.object({}),
  async handler(ctx: ServerContext, _input: z.infer<typeof this.schema>) {
    return ctx.browser.call("validate_graph", {});
  },
};
// Same for validate_connections, validate_parameters, validate_subflows
```

### tools/conversion.ts (3 server-side, 3 browser-proxy)

- `compile_nntree`, `export_diagram`, `import_diagram` → thin proxies
- `execute_conversion` → queries browser for NNTree JSON, then writes temp file + runs `convert.py`:
  ```typescript
  async handler(ctx: ServerContext, input) {
    const nntree = await ctx.browser.call("compile_nntree", {});
    const result = await ctx.pipeline.executeConversion(nntree.json, { ... });
    return result;
  }
  ```
- `execute_training`, `execute_inference` → unchanged (pure server-side Python)

### tools/canvas.ts (3 tools → real browser calls)

Remove stub comments. Each tool now actually calls the browser:

```typescript
export const get_canvas_state = {
  schema: z.object({}),
  async handler(ctx: ServerContext) {
    return ctx.browser.call("get_canvas_state", {});
  },
};
// fit_view, center_view similarly
```

### tools/lifecycle.ts (2 tools → thin proxies)

```typescript
export const reset_diagram = {
  schema: z.object({}),
  async handler(ctx: ServerContext) {
    return ctx.browser.call("reset_diagram", {});
  },
};

export const ping = {
  schema: z.object({}),
  async handler(ctx: ServerContext) {
    return ctx.browser.call("ping", {});
  },
};
```

## Files to Delete

- `mcp-server/src/tools/transaction.ts`
- `mcp-server/src/tools/history.ts`
- `mcp-server/src/tools/events.ts`
- `mcp-server/src/resources/index.ts`

## Test Plan
- All existing tool unit tests break (they create server-side DiagramCore) → will be rewritten in Phase 6
- Verify svelte-check passes on frontend
- Verify TypeScript compiles on mcp-server
