# Eliminating Svelte Callbacks from Node Data

## Objective

Remove Svelte-specific callbacks (`onToggle`, `onResizeEnd`) from subflow node `data`, eliminating the need for overrides in `Diagram.svelte.ts` and making node data purely serializable.

## Problem

`SubflowNode.svelte` required two callbacks in the node's `data`:

- **`onToggle(id, collapsed)`** — called when the collapse/expand button is clicked
- **`onResizeEnd(id, w, h)`** — called after resize to save dimensions

Functions don't survive `JSON.stringify`/`parse`. This forced `Diagram.svelte.ts` to override `importFromJson` (re-hydrate callbacks after load) and `addSubGraph` (inject callbacks at creation).

## Solution

### 1. `onResizeEnd` — Eliminated, saving moved into `toggleSubflow`

`NodeResizer` automatically updates `node.width`/`node.height` via Svelte Flow. At collapse time, `toggleSubflow` reads these current values and saves them to `oldWidth`/`oldHeight`.

```
Before: resize → onResizeEnd saves oldWidth → collapse uses oldWidth → expand restores oldWidth
After:  resize → collapse saves node.width to oldWidth → expand restores oldWidth
```

### 2. `onToggle` — Replaced with `setContext`/`getContext`

`FlowCanvas.svelte` exposes the `diagram` via Svelte context. `SubflowNode.svelte` retrieves it with `getContext` and calls `diagram.toggleSubflow(id, !isCollapsed)` directly — no callbacks in data.

### 3. Overrides removed from `Diagram.svelte.ts`

The file goes from 129 to 22 lines, containing only:
- `$state.raw` declaration for `nodes`/`edges`
- Constructor with `initStereotypes` + auto-spawn Input

## Files Modified

| File | Change |
|---|---|
| `Diagram.svelte.ts` | Removed `importFromJson` and `addSubGraph` overrides (129→22 lines) |
| `FlowCanvas.svelte` | Added `setContext<DiagramCore>("diagram", diagram)` |
| `SubflowNode.svelte` | `getContext("diagram")` instead of `data.onToggle`; removed `onResizeEnd` handler and `SubflowData` type entries |
| `DiagramCore.ts` | `toggleSubflow` now saves `oldWidth`/`oldHeight` at collapse time instead of reading pre-saved values; comments updated |

## Verification

- `npm run check`: 0 errors, 7 warnings (pre-existing)
- `npm run test`: 86 tests passed out of 86

## Architectural Impact

- `DiagramCore` remains pure TypeScript (zero Svelte dependencies)
- `Diagram.svelte.ts` is now truly a "thin wrapper" (the original Phase 1 refactoring goal)
- Node data is fully serializable — no functions in data
- `SubflowNode.svelte` uses the standard Svelte `setContext`/`getContext` pattern to access the diagram
