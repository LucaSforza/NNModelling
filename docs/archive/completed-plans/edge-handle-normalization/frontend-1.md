# Edge Handle Normalization on Import

## Objective

Fix backwards compatibility: old diagrams (saved before Phase 14) have edges
without `sourceHandle` and `targetHandle` fields. Since Phase 14 added explicit
`id="in"` / `id="out"` to Handles in `CustomNode.svelte`, SvelteFlow cannot
match these edges to handles, making them **invisible on the canvas**.

## Context — Why This Happened

**Before Phase 14:**
- `CustomNode.svelte` Handles had no `id` attribute → SvelteFlow defaulted handles to `id=null`
- `SubflowNode.svelte` Handles also had no `id` (missed in Phase 14 fix)
- Edges created by drag-and-drop also had `null` handles → everything matched
- Export saved edges without `sourceHandle`/`targetHandle`

**Phase 14** added `id="in"` / `id="out"` to `CustomNode.svelte` Handles and
defaulted `addEdge` to use `"out"`/`"in"`. But `SubflowNode.svelte` was missed
— its Handles still had no `id`.

**Result:** Old diagrams with subflows (like `transformer_classifier.json`)
have edges that don't render because SubflowNode handles have no `id` to match
against.

## Files Modified

### 1. `front-end/src/core/DiagramCore.ts` — `importFromJson`

Normalize edges on import: fill missing `sourceHandle` → `"out"`,
`targetHandle` → `"in"`.

```ts
this.edges = this.edges.map((edge: any) => {
  if (!edge.sourceHandle) edge.sourceHandle = "out";
  if (!edge.targetHandle) edge.targetHandle = "in";
  return edge;
});
```

**Rationale:**
- `sourceHandle = "out"` — universal (CustomNode, SubflowNode, JoinNode all use `id="out"`)
- `targetHandle = "in"` — correct for CustomNode and SubflowNode. JoinNode edges
  in old files already have explicit `targetHandle` (`"in-0"`, `"in-1"`) so the
  `if (!edge.targetHandle)` guard leaves them untouched.

### 2. `front-end/src/nodes/SubflowNode.svelte` — Handles

Added `id="in"` to target Handle (line 72) and `id="out"` to source Handle (line 117).
These were missing from the Phase 14 fix which only addressed CustomNode.svelte.

**Before:**
```svelte
<Handle type="target" position={Position.Top} />
...
<Handle type="source" position={Position.Bottom} />
```

**After:**
```svelte
<Handle type="target" id="in" position={Position.Top} />
...
<Handle type="source" id="out" position={Position.Bottom} />
```

## Test Results

```
Unit:        269 passed, 5 skipped  ✓
Smoke (T0):   64 passed             ✓
Convert (T1): 34 passed             ✓
```
