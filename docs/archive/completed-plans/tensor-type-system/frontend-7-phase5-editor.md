# Task frontend-7 — Phase 5: Editor Integration

**Designer**: `@designer` (visual: error display, node indicators)  
**Implementer**: `@frontend` (wiring: engine calls, state management)

---

## Objective

Wire `TypeEngine.infer(diagram)` into the visual editor so type errors surface in real-time as the user edits the diagram.

---

## Part A — State Management

### A1. Add type state to `Diagram.svelte.ts`

Add to the `Diagram` class:

```typescript
import { TypeEngine } from './conversion/typeEngine';
import type { TypeResult, TypeError } from './conversion/tensortypes';

export class Diagram {
  // ... existing state ...

  /** Latest type inference result. null = not yet computed */
  public typeResult: TypeResult | null = $state.raw(null);

  /** Run type inference and cache the result */
  public checkTypes(): void {
    this.typeResult = TypeEngine.infer(this);
  }
}
```

### A2. Call `checkTypes()` on relevant events

From `FlowCanvas.svelte`, call `diagram.checkTypes()` when:
- An edge is added (`onConnect`)
- An edge is removed (`onEdgesChange` with remove type)
- Diagram is loaded (`importFromJson`)

From `Sidebar.svelte`, call `diagram.checkTypes()` when:
- A param value changes (debounced ~300ms)

---

## Part B — Visual Error Display (`@designer` first, then `@frontend`)

### B1. Sidebar — Error Panel

Add a collapsible section at the bottom of the Sidebar that lists type errors:

```
┌─ Type Errors (2) ────────────────────┐
│ ❌ Linear_1: in_features mismatch    │
│    expected 300, got 200            │
│                                      │
│ ⚠️  Fork_0: No type signature       │
└──────────────────────────────────────┘
```

- **Error** (red): hard errors that would cause runtime crashes
- **Warning** (yellow/amber): missing type signatures, unresolved params

Clicking an error should focus/select the offending node on the canvas.

### B2. Canvas — Node Error Indicators

Nodes with errors should show a **red border** (2px) and a small ⚠️ icon in the top-right corner.

Nodes with warnings should show an **amber border** (2px).

The indicator should disappear when the error is resolved.

### B3. Canvas — Shape Tooltip

On hover over a node's output handle, show a tooltip with the inferred output shape:

```
Output: [B, 256]  float32
```

---

## Part C — Implementation Plan

### Step 1: Designer (`@designer`)

Design the visual specs:
1. Error panel layout in Sidebar (colors, spacing, typography)
2. Node error indicator (border color, icon, position)
3. Shape tooltip (position, style, animation)

Return CSS variables and layout specs for the frontend to implement.

### Step 2: Frontend (`@frontend`)

Implement based on designer specs:
1. `Diagram.checkTypes()` method
2. Call `checkTypes()` from FlowCanvas (onConnect, onEdgesChange, importFromJson)
3. Call `checkTypes()` from Sidebar (on param change, debounced)
4. Error panel component in Sidebar
5. Error indicator on CustomNode.svelte (read `diagram.typeResult`)
6. Shape tooltip on node handles

---

## Files to Modify

| File | Change |
|------|--------|
| `Diagram.svelte.ts` | Add `checkTypes()`, `typeResult` state |
| `FlowCanvas.svelte` | Call `checkTypes()` on edge events |
| `Sidebar.svelte` | Call `checkTypes()` on param change; add error panel |
| `nodes/CustomNode.svelte` | Read typeResult, show red/amber border + icon |
| `nodes/JoinNode.svelte` | Same indicators |
| `nodes/SubflowNode.svelte` | Same indicators |

---

## Tests

- Manual testing: create a mismatch, verify red border appears
- Existing vitest tests continue to pass (no regression)
- No new unit tests needed (visual behavior is tested manually)

---

## Execution Order

1. `@designer` — design error panel + node indicators + tooltip visuals
2. `@frontend` — implement based on designer specs
3. `npx vitest run` — verify no regressions
4. `npm run dev` — manual smoke test
5. Commit: "feat: Phase 5 — editor integration for type checking"
