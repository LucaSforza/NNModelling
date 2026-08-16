---
id: T05
kind: task
status: draft
plan: ../plan.md
role: frontend
depends_on:
  - T03
parallel_with:
  - T06
  - T07
write_scope:
  - Stereotypes/Modules/
  - front-end/src/__tests__/moduleTypeSignaturesV2.test.ts
---

# Migrate module, source and loss signatures

## Objective

Convert every JSON file under `Stereotypes/Modules/` to the v2 schema and prove
its declared tensor behavior using only generic language primitives.

## Context required

- [Initiative plan](../plan.md), stereotype matrix and sections C-D.
- T01-T03 handoffs.
- Python/custom operations for any signature whose runtime fidelity is in
  question.

## Invariants

- Preserve parameter names/defaults, visual metadata and Python class names.
- Use `ComputedDimension` when rank/structure is fixed; use `ComputedShape` only
  when the whole shape changes structurally.
- Do not add a new operator to make one module easier to encode.
- Preserve the documented conceptual `[B]` Loss output unless a separate runtime
  decision changes it.

## Allowed files

- All JSON files under `Stereotypes/Modules/`.
- `front-end/src/__tests__/moduleTypeSignaturesV2.test.ts`.

## Out of scope

- Join/Subflow JSON, engine changes and Python runtime adapters for
  MultiheadAttention/Transformer/Decoder.

## Work

1. Migrate ordinary identity/pattern modules and explicit dtype expressions.
2. Encode Conv/Pool/Upsample scalar/list parameter selection and constraints
   according to the approved supported subset.
3. Encode Flatten, Unflatten and SequencePool with whole-shape expressions.
4. Tighten normalization/positional/axis constraints where the runtime contract
   is unambiguous.
5. For multi-argument PyTorch modules currently presented as unary, encode only
   the explicitly approved subset and document the excluded runtime behavior in
   the test name/fixture; do not fake it in the evaluator.
6. Compile every migrated JSON and add representative success/failure tests.

## Acceptance criteria

- [ ] Every `Modules/*.json` signature is v2 and compiles.
- [ ] No legacy signature `kind` or action remains; every human-readable
      expression string parses and type-checks under the canonical v2 grammar.
- [ ] Tuple/scalar and unset/invalid cases have explicit tests.
- [ ] Known runtime-interface gaps are not silently claimed as supported.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/moduleTypeSignaturesV2.test.ts
pnpm --dir front-end check
```

## Required handoff

Return a row for every migrated module, behavior encoded, tests run and runtime
semantics deferred to another initiative.
