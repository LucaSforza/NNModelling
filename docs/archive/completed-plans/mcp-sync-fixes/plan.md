# Milestone: MCP Synchronization & Node Creation Fixes

## Summary

Three related bugs discovered during MCP API interaction:

| # | Bug | Severity | Root Cause |
|---|-----|----------|------------|
| 1 | Edges created via RPC don't render on canvas | High | Handle ID mismatch between `DiagramCore.addEdge` defaults (`"out"`/`"in"`) and `CustomNode.svelte` (no explicit `id`, so SvelteFlow uses `null`) |
| 2 | `fit_view` / `center_view` are no-ops via RPC | Medium | `BrowserRPCHandler` stubs return `{ success: true }` without calling SvelteFlow API |
| 3 | `create_node` params don't merge with stereotype defaults | High | `addModule`/`addJoinNode` use all-or-nothing: user params replace defaults entirely instead of merging |

---

## Bug 1: Edge Rendering Failure

### Root Cause

```
CustomNode.svelte target Handle:  <Handle type="target" ... />          → id = null (SvelteFlow default)
CustomNode.svelte source Handle:  <Handle type="source" ... />          → id = null (SvelteFlow default)

DiagramCore.addEdge defaults:     sourceHandle = "out", targetHandle = "in"
```

When `connect_nodes` RPC executes `diagram.addEdge(src, tgt)` without explicit handles, the edge is created with `sourceHandle: "out"` / `targetHandle: "in"`. SvelteFlow renders edges by matching handle IDs — an edge with `targetHandle: "in"` cannot find a handle on the target node (which has id `null`), so it's silently not drawn.

**Evidence**: `get_graph` returns the edge in `diagram.edges` (state mutation works), but it's invisible on canvas.

**Note**: This works for `JoinNode` because it has explicit handle IDs (`"in-0"`, `"in-1"`, `"out"`).

### Fix

Add explicit `id` attributes to `CustomNode.svelte` Handles:
```svelte
<Handle type="target" id="in" ... />
<Handle type="source" id="out" ... />
```

This makes programmatic edges match actual handle IDs. No change to `DiagramCore.addEdge` needed.

**Impact**: Zero breaking change. UI-dragged edges already work (SvelteFlow auto-detects handles). This just makes the implicit IDs explicit.

---

## Bug 2: fit_view / center_view Stubs

### Root Cause

`BrowserRPCHandler.ts` lines 933-943:
```typescript
private handleFitView(_params)  { return { success: true, note: "fit_view executed" }; }
private handleCenterView(_params) { return { success: true, note: "center_view executed" }; }
```

These are no-ops. The handler has no reference to the SvelteFlow instance (`useSvelteFlow()`), which lives in `FlowCanvas.svelte`.

### Fix

Inject SvelteFlow viewport functions into `BrowserRPCHandler` via constructor:

1. `FlowCanvas.svelte`: Extract `fitView`/`setCenter` from `useSvelteFlow()`, pass to `BrowserRPCHandler` constructor.
2. `BrowserRPCHandler`: Accept optional `viewport` parameter, call `this.viewport.fitView(...)` and `this.viewport.setCenter(...)` in handlers.

---

## Bug 3: Parameter Merging in addModule / addJoinNode

### Root Cause

`DiagramCore.addModule` line 141:
```typescript
params: customConfig?.params ? JSON.parse(JSON.stringify(customConfig.params)) : {},
```

This is all-or-nothing. When user provides `{ "in_features": "128", "out_features": "64" }` for a `Linear` node, the entire stereotype defaults (`bias`, `device`, `dtype`) are discarded. The `getDefaultParams()` private method (line 608) exists but is **never called** in `addModule`.

Same bug in `addJoinNode` line 179.

**Evidence**: User reported "Undefined" for `in_features` when providing params via `create_node`. Working around it with `set_parameter` after creation (which uses `updateModule`, a different code path) succeeded.

### Fix

Add a `_mergeNodeParams` private method that:
1. Always starts with stereotype defaults (from `getDefaultParams()`, producing `{ value, position }` wrapper objects)
2. Overlays user-supplied `Record<string, string>`, wrapping each value in `{ value }` while preserving `position` from defaults

Use this in both `addModule` and `addJoinNode` instead of the current all-or-nothing logic.

---

## Files Affected

| File | Change |
|------|--------|
| `front-end/src/nodes/CustomNode.svelte` | Add `id="in"` / `id="out"` to Handle components |
| `front-end/src/sync/BrowserRPCHandler.ts` | Accept viewport callbacks via constructor; implement real fit_view/center_view |
| `front-end/src/FlowCanvas.svelte` | Pass viewport functions to BrowserRPCHandler |
| `front-end/src/core/DiagramCore.ts` | Add `_mergeNodeParams` helper; fix `addModule` and `addJoinNode` |

## Test Plan

New tests to be written (failing before fix, passing after):

### Test A: Params merging in addModule (file: `__tests__/paramsMerge.test.ts`)
- `addModule` with `Linear` + partial params: verify bias/device/dtype defaults are preserved
- `addModule` with no params: verify all defaults come through
- `addModule` with `{ value, position }` wrapper format params: verify proper merging
- `addJoinNode` with `Einsum` + partial params: verify defaults preserved

### Test B: Edge handle defaults (file: `__tests__/edgeHandles.test.ts`)
- `addEdge` without explicit handles → `sourceHandle: "out"`, `targetHandle: "in"`
- Documents the contract that CustomNode must match

### Test C: fit_view / center_view via viewport injection (file: `__tests__/BrowserRPCHandler.test.ts`)
- Creating handler with viewport mock → `fit_view` calls `fitView()`
- Creating handler with viewport mock → `center_view` calls `setCenter()`
- Creating handler WITHOUT viewport → `fit_view` doesn't throw (graceful no-op)

## Phase Order

1. **Phase 1**: Write failing tests (this document + test files)
2. **Phase 2**: Review failing tests → confirm bugs
3. **Phase 3**: Implement fixes
4. **Phase 4**: Verify all tests pass + existing test suite unchanged
