---
id: T01
kind: task
status: done
plan: ../plan.md
role: frontend
depends_on: []
parallel_with: []
write_scope:
  - front-end/src/core/containment.ts
  - front-end/src/core/validation.ts
  - front-end/src/core/DiagramCore.ts
  - front-end/src/utils.ts
  - front-end/src/FlowCanvas.svelte
  - front-end/src/__tests__/containment.test.ts
  - front-end/src/__tests__/graphChange.test.ts
---

# Enforce subflow containment boundaries

## Objective

Make every graph-editing path preserve the rule that an edge's endpoints must
belong to the same immediate containment scope.

## Context required

- [Automatic compound layout](../plan.md)
- [Recursive layout decision](../../../../knowledge/decisions/recursive-compound-layout.md)
- `DiagramCore.addEdge()`, `DiagramCore.reconnectEdge()` and
  `DiagramCore.importFromJson()`
- `checkValidConnection()` in `front-end/src/core/validation.ts`
- `onNodeDragStop()` in `front-end/src/utils.ts`

## Invariants

- Top-level nodes share the normalized scope `null`.
- Direct children share the scope identified by their common `parentId`.
- A nested subflow is an atomic node in its own parent's scope.
- No mutation or failed import captures undo state or emits a graph-change
  notification when rejected.
- Directed-cycle and target-handle occupancy validation remain intact.
- Reparenting retains ancestry-loop protection and parent-before-child order.

## Allowed files

- Only the files listed in `write_scope`.
- `containment.ts` owns reusable pure scope and ancestry checks; it must not own
  diagram state.
- `FlowCanvas.svelte` may change only at the `onNodeDragStop()` call site to
  pass the current edge array required by containment validation.

## Out of scope

- Computing positions or dimensions.
- Automatically deleting or rewriting an invalid edge.
- Migrating malformed legacy diagrams by guessing intended subflow handles.

## Work

1. Add pure helpers for normalized scope lookup, parent-chain validation and
   same-scope edge validation.
2. Extend connection and reconnection validation to reject cross-scope edges
   before undo capture.
3. Block a drag reparent operation when any incident edge would cross a scope
   after the move; leave the node and all edges unchanged.
4. Validate containment references, parent cycles, parent types and edge scopes
   before accepting imported nodes and edges.
5. Add regression coverage for top-level, internal, nested, reconnect, drag and
   import paths plus notification/undo no-op behavior.

## Acceptance criteria

- [ ] Top-level-to-top-level and sibling-to-sibling edges remain valid.
- [ ] A subflow node connects normally to siblings in its parent's scope.
- [ ] Child-to-parent, child-to-outside and cross-subflow edges are rejected.
- [ ] Reconnection cannot bypass the boundary rule.
- [ ] Reparenting a connected node cannot strand an incident edge across a
      boundary.
- [ ] Imports with missing/non-subflow parents, parent cycles or cross-scope
      edges fail atomically; valid existing examples still import.
- [ ] Rejections do not consume undo history or notify graph subscribers.
- [ ] No changes occur outside `write_scope`.

## Validation

Run from the repository root:

```bash
pnpm --dir front-end test -- src/__tests__/containment.test.ts src/__tests__/graphChange.test.ts
pnpm --dir front-end check
```

## Required handoff

Return:

- files changed and a concise explanation of each change;
- exact commands run and their results;
- the normalized-scope rule used by every mutation path;
- any valid historical fixture rejected by the stricter import contract;
- unresolved risks or follow-up work.
