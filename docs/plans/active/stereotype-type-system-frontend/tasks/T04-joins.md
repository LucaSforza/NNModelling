---
id: T04
kind: task
status: draft
plan: ../plan.md
role: frontend
depends_on: [T03]
parallel_with: []
write_scope:
  - front-end/src/type-system/
  - front-end/src/__tests__/packageTypeJoins.test.ts
  - stereotype-packages/core/add/
  - stereotype-packages/core/concat/
---

# Add ordered join inference

## Objective

Infer `core.add` and `core.concat` from target-handle-ordered inputs, including
shape and dtype failures, without adding either package to central engine code.

## Context required

- Read the plan, T03 handoff, current `orderJoinInputs` contract, and reference
  join packages/tests.
- Read reference kind cardinalities and tensor equality/dimension functions.
- Copy `packages/core/add/` and `packages/core/concat/`; adapt the matching
  cases from `src/packages/standard-library.test.ts` and reuse the tensor
  helpers from `src/lua/lua-inference-runtime.ts`.

## Invariants

- Join input order comes from `targetHandle` (`in-0`, `in-1`, ...), never edge
  array or traversal order.
- `Add` requires exact tensor equality; `Concat` has no broadcasting or
  symbolic size expression.
- Dtypes must match exactly and are preserved.

## Out of scope

Subflows, dynamic join references, broadcasting, promotion, backend, and
legacy join actions.

## Acceptance criteria

- [ ] Add and Concat valid/targeted-invalid results match the oracle.
- [ ] Reversing stored edge order without changing target handles preserves
  semantic input order.
- [ ] A user-defined package of kind `join` can use the same host path without
  central code changes.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/packageTypeJoins.test.ts src/type-system
pnpm --dir front-end check
git diff --check
```

## Required handoff

Return ordering evidence, candidate/oracle cases, commands/results, and any
standard-library primitive added with its package-independent rationale, plus
the mandatory reference-to-NNModelling reuse ledger.
