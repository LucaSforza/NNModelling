---
id: T03
kind: task
status: ready
plan: ../plan.md
role: frontend
depends_on:
  - T02
parallel_with: []
write_scope:
  - front-end/src/core/types.ts
  - front-end/src/core/DiagramCore.ts
  - front-end/src/Diagram.svelte.ts
  - front-end/src/__tests__/graphChange.test.ts
  - front-end/src/__tests__/fuzz/serialization.test.ts
  - front-end/src/__tests__/layoutState.test.ts
---

# Apply layout as atomic diagram state

## Objective

Expose automatic layout through `DiagramCore` so positions, subflow dimensions
and direction change as one undoable, serializable mutation.

## Context required

- [Automatic compound layout](../plan.md)
- `computeAutoLayout()` from T02
- `DiagramCoreSnapshot`, undo/redo, import/export and graph-change contracts
- Reactive `$state.raw` ownership in `front-end/src/Diagram.svelte.ts`

## Invariants

- Layout computation succeeds before `_captureUndoState()` is called.
- One accepted non-no-op layout captures once and notifies synchronously once.
- Rejected and identical layouts capture and notify zero times.
- `Diagram.svelte.ts` stays a thin reactive wrapper; geometry logic remains
  pure or in `DiagramCore`.
- Existing diagram JSON without direction metadata remains loadable and
  defaults to vertical.
- NNTree compilation receives unchanged semantic graph data.

## Allowed files

- Only the state, wrapper and test files listed in `write_scope`.
- Do not add browser APIs or viewport callbacks to `DiagramCore`.

## Out of scope

- Toolbar controls, handle components and viewport fitting.
- Adding an MCP layout tool.
- Changing NNTree serialization.

## Work

1. Add `LayoutDirection` to diagram presentation state and snapshots.
2. Add a public `autoLayout(direction)` mutation that computes off-state,
   detects semantic geometry no-ops, captures once, replaces the node array,
   updates direction and notifies once.
3. Restore direction through undo/redo snapshots.
4. Export optional direction metadata and import it with a vertical fallback;
   keep import validation atomic.
5. Extend graph-change and serialization tests, including horizontal
   round-trip, old-file fallback, undo/redo and repeated-layout no-op cases.

## Acceptance criteria

- [ ] One layout produces exactly one undo entry and one notification.
- [ ] A single undo restores all old positions, sizes and handle direction; one
      redo reapplies them.
- [ ] Repeating an identical direction/layout is a no-op.
- [ ] Horizontal save/load round-trips exactly.
- [ ] Legacy JSON without `layoutDirection` loads vertically.
- [ ] Invalid direction input cannot enter state.
- [ ] Layout leaves the edge array and NNTree semantics unchanged.
- [ ] `$state.raw` arrays are replaced so Svelte observes the mutation.
- [ ] No changes occur outside `write_scope`.

## Validation

Run from the repository root:

```bash
pnpm --dir front-end test -- src/__tests__/layoutState.test.ts src/__tests__/graphChange.test.ts src/__tests__/fuzz/serialization.test.ts
pnpm --dir front-end check
```

## Required handoff

Return:

- files changed and a concise explanation of each change;
- exact commands run and their results;
- serialized metadata shape and fallback behavior;
- notification and undo/no-op evidence;
- unresolved compatibility risks or follow-up work.
