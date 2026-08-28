---
id: T02
kind: task
status: done
plan: ../plan.md
role: frontend
depends_on: [T01]
parallel_with: []
write_scope:
  - front-end/src/type-system/
  - front-end/src/core/types.ts
  - front-end/src/core/DiagramCore.ts
  - front-end/src/Diagram.svelte.ts
  - front-end/src/__tests__/packageTypeGraph.test.ts
  - front-end/src/__tests__/serialization.test.ts
  - stereotype-packages/core/fork/
---

# Infer reachable regions of the editor graph

## Objective

Drive package inference from a read-only `DiagramCore` snapshot so
`core.input -> core.fork` infers locally, including inside an otherwise
incomplete editor graph, and new nodes persist exact package identity.

## Context required

- Read the plan, migration decision, T01 handoff, `DiagramCore`, `Diagram`, and
  current import/export tests.
- In the reference, read `packages/core/fork/`, the input/layer topology rules,
  and the NNModelling integration document.
- Copy `packages/core/fork/` and adapt its cases from
  `src/packages/standard-library.test.ts`; use `src/type-inference.ts` as the
  semantic context contract. Only the `DiagramCore` scheduler and persistence
  adapter should be NNModelling-specific.

## Invariants

- `DiagramCore` remains the only mutable graph authority.
- New nodes save canonical `{id, version, name}`; resolution uses ID and exact
  version only.
- Zero/multiple terminals mean incomplete; one terminal means complete.
- Every resolvable region is inferred; unresolved predecessors are not passed
  to package Lua.
- Source fan-out does not require a special type rule.

## Out of scope

Legacy diagram migration, diagnostic UI, joins, subflow composition, backend,
and deletion or semantic modification of `TypeEngine`.

## Acceptance criteria

- [ ] `Input -> Fork` preserves shape and dtype through package Lua.
- [ ] Disconnecting a downstream region leaves the reachable upstream region
  inferred and marks only the dependent region unresolved.
- [ ] Completeness reports zero, one, and multiple terminal cases correctly.
- [ ] Save/load round-trips ID, exact version, and display name.
- [ ] Join ordering and containment invariants remain unchanged.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/packageTypeGraph.test.ts src/__tests__/serialization.test.ts
pnpm --dir front-end check
git diff --check
```

## Required handoff

Return the persisted node shape, graph scheduling order, commands/results, and
every temporary coexistence seam that the final cutover must delete, plus the
mandatory reference-to-NNModelling reuse ledger.
