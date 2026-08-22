---
id: T05
kind: task
status: done
plan: ../plan.md
role: frontend
depends_on: [T04]
parallel_with: []
write_scope:
  - front-end/src/type-system/
  - front-end/src/__tests__/packageTypeSubflows.test.ts
  - stereotype-packages/core/repeat/
  - stereotype-packages/core/horizontal-repeat/
---

# Compose nested subflow inference

## Objective

Infer sequential `Repeat` and parallel `Horizontal Repeat`, including dynamic
join selection, while preserving an inner failure and appending exact
iteration, branch, subflow, and referenced-package context.

## Context required

- Read the plan, T04 handoff, current containment/subflow compilation rules,
  and reference composition, dependency, lifecycle, and tests.
- Inspect reference repeat and horizontal-repeat packages completely.
- Copy/adapt `packages/core/repeat/`, `packages/core/horizontal-repeat/`,
  relevant `src/models/` fixtures, and `src/models/subflow-models.test.ts`.
  Reuse reference dependency/capability logic unless `DiagramCore` translation
  requires an adapter.

## Invariants

- The graph adapter supplies only the nested subflow capability allowed by the
  package kind.
- Every branch/iteration is inferred independently with host-owned depth
  limits.
- Dynamic references access only explicitly authorized active package IDs and
  do not activate packages implicitly.
- The leaf cause is preserved; outer contexts append inner-to-outer frames.

## Out of scope

Weight construction/sharing, PyTorch, package installation, arbitrary
recursion, and alternative composed-scenario formats.

## Acceptance criteria

- [ ] Repeat composes output into the next iteration and reports the exact
  failing iteration.
- [ ] Horizontal Repeat infers branches independently, reports the exact
  branch, and delegates to the selected active join.
- [ ] Missing/incompatible/unauthorized dynamic joins have the reference
  expected outcome and no leaked leases.
- [ ] Collapsed/hidden nested children remain inferable.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/packageTypeSubflows.test.ts src/type-system
pnpm --dir front-end check
git diff --check
```

## Required handoff

Return nested diagnostic examples, lease/depth evidence, candidate/oracle
comparisons, commands/results, and the mandatory reference-to-NNModelling reuse
ledger.
