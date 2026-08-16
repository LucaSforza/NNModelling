---
id: T06
kind: task
status: draft
plan: ../plan.md
role: frontend
depends_on:
  - T03
parallel_with:
  - T05
  - T07
write_scope:
  - Stereotypes/Joins/
  - front-end/src/__tests__/joinTypeSignaturesV2.test.ts
---

# Migrate Join signatures to groups, constraints and shape definitions

## Objective

Convert all Join JSON to v2 so Addition, Concat, MatMul and attention behavior is
fully declarative and Einsum is selected only by `EinsumShape`.

## Context required

- [Initiative plan](../plan.md), sections A.6, C.4 and D.4.
- T03 evaluator/Einsum handoff.
- Ordered-handle invariant in `front-end/src/conversion/nnTree.ts:17-34`.

## Invariants

- Addition and Concat use one `2..*` group.
- MatMul and Q/K operations use two distinct `1..1` groups with labels.
- Constraints, not wildcard policy, express cross-input relationships.
- No operator/action is named Addition, Concat or MatMul.
- Einsum equation parameter is explicit in `EinsumShape`.

## Allowed files

- All JSON files under `Stereotypes/Joins/`.
- `front-end/src/__tests__/joinTypeSignaturesV2.test.ts`.

## Out of scope

- Join UI controls, graph ordering changes and general broadcasting semantics
  not approved by the plan.

## Work

1. Encode variadic Addition with equality constraints and ordinary pattern
   output.
2. Encode Concat with general collection/axis constraints and ComputedShape.
3. Encode MatMul with two patterns, shared local dimensions and the agreed
   batch-prefix rule; add a genuine positive and negative matrix fixture.
4. Migrate scaled/masked dot product patterns and explicit dtype behavior.
5. Encode Einsum as an arity-compatible group plus `EinsumShape`; test a renamed
   stereotype fixture to prove name independence.
6. Test three-input Addition/Concat, rank/axis mismatch and ordered groups.

## Acceptance criteria

- [ ] Every `Joins/*.json` signature is v2 and compiles.
- [ ] No `join`, `action`, `dim_expr`, `einsum_param` or implicit captured-shape
      equality remains.
- [ ] Required variadic and Einsum cases pass using T03 only.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/joinTypeSignaturesV2.test.ts src/__tests__/einsumShape.test.ts
pnpm --dir front-end check
```

## Required handoff

Return migrated Join contracts, exact tests/results, chosen MatMul batch policy
and any dtype behavior that intentionally differs from current implicit rules.
