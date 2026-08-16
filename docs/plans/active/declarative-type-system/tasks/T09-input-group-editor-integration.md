---
id: T09
kind: task
status: draft
plan: ../plan.md
role: frontend
depends_on:
  - T08
parallel_with:
  - T10
write_scope:
  - front-end/src/nodes/JoinNode.svelte
  - front-end/src/core/DiagramCore.ts
  - front-end/src/core/types.ts
  - front-end/src/sync/BrowserRPCHandler.ts
  - front-end/src/__tests__/BrowserRPCHandler.test.ts
  - front-end/src/__tests__/graphChange.test.ts
  - front-end/src/__tests__/layout.test.ts
---

# Integrate InputGroup arity with Join creation and editing

## Objective

Make visible Join handles, local creation and browser RPC respect the lower and
upper arity derived from compiled input groups.

## Context required

- [Initiative plan](../plan.md), sections A.6 and E Phase 7.
- T08 compiled-signature access through `StereotypeCore`.
- Current `JoinNode.svelte:34-102` and `DiagramCore.ts:271-293`.

## Invariants

- Connected parent order remains numeric `targetHandle` order.
- Existing `inputsCount` persists through import/export/duplicate/undo/redo.
- UI bounds are presentation/creation constraints; imported invalid state is
  diagnosed, not silently rewritten.
- Every accepted public DiagramCore mutation keeps one snapshot/notification.

## Allowed files

- Only the seven paths in `write_scope`.

## Out of scope

- Signature evaluation, stereotype migration and general Join visual redesign.

## Work

1. Derive a Join signature's minimum, fixed maximum or unbounded maximum from
   its ordered groups.
2. Use the minimum as the default visible handle count for local and RPC
   creation.
3. Disable decrement at the lower bound and increment at a finite upper bound;
   fixed MatMul/attention joins expose no effective arity mutation.
4. Preserve old saved counts and emit/retain the T08 arity diagnostic when they
   violate a signature.
5. Cover three-input Addition/Concat, fixed two-input MatMul, Einsum arity,
   duplication and RPC creation.

## Acceptance criteria

- [ ] UI, core and RPC compute identical bounds.
- [ ] Variadic Joins accept a third connected input and fixed Joins do not expose
      a third handle.
- [ ] No edge reordering or silent imported-state mutation occurs.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/BrowserRPCHandler.test.ts src/__tests__/graphChange.test.ts src/__tests__/layout.test.ts
pnpm --dir front-end check
```

## Required handoff

Return arity derivation rules, compatibility behavior, files changed, exact
tests/results and any manual interaction still needed.
