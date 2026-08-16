---
id: T07
kind: task
status: draft
plan: ../plan.md
role: frontend
depends_on:
  - T04
parallel_with:
  - T05
  - T06
write_scope:
  - Stereotypes/SubFlows/
  - front-end/src/__tests__/subflowTypeSignaturesV2.test.ts
---

# Migrate normal, HorizontalRepeat and Repeat subflow signatures

## Objective

Represent every subflow transform as generic `ComputedShape`/dtype expressions
and provide a declarative contract for ordinary anonymous containers.

## Context required

- [Initiative plan](../plan.md), sections A.7, C.3 and D.4.
- T04 subflow application handoff.
- Runtime behavior in `converted/src/ops/subflow.py`,
  `horizontal_repeat.py` and `repeat.py`.

## Invariants

- The internal graph is invoked only through the generic `apply` capability.
- Repeat is `iterate(apply)` and may change shape on every compatible step.
- HorizontalRepeat transforms the actual applied subflow result, not the input.
- Count/rank requirements are general constraints.
- No action, last-dimension transform descriptor or stereotype-name check is
  allowed.

## Allowed files

- JSON files under `Stereotypes/SubFlows/`, including a generic Subflow
  declaration if T01 approved it.
- `front-end/src/__tests__/subflowTypeSignaturesV2.test.ts`.

## Out of scope

- Diagram import normalization and production TypeEngine integration; T08 owns
  those paths.

## Work

1. Add/encode a normal subflow signature as one input group and `apply` output.
2. Encode HorizontalRepeat with readable `apply`, `shape`, `dim`, arithmetic and
   `replace`, plus integer/rank constraints.
3. Encode Repeat with generic `iterate` and an explicit iteration parameter.
4. Compile each JSON and test normal, nested, shape-changing, incompatible-next-
   iteration, invalid-count and unresolved-count cases.
5. Verify dtype comes from the applied/final tensor expression.

## Acceptance criteria

- [ ] Every `SubFlows/*.json` signature is v2 and compiles.
- [ ] No `subflow`, `action`, `iterations_param`, `infer_then_transform`,
      `last_dim` or `multiply` field remains.
- [ ] Repeat does not assume shape preservation.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/subflowTypeSignaturesV2.test.ts src/__tests__/subflowTypeExpressions.test.ts
pnpm --dir front-end check
```

## Required handoff

Return migrated signatures, exact tests/results, generic Subflow identity and
any rank/count edge case still unresolved.
