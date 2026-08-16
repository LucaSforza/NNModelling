---
id: T03
kind: task
status: draft
plan: ../plan.md
role: frontend
depends_on:
  - T01
  - T02
parallel_with: []
write_scope:
  - front-end/src/type-system/inputGroups.ts
  - front-end/src/type-system/shapePatterns.ts
  - front-end/src/type-system/signatureEvaluator.ts
  - front-end/src/type-system/einsumShape.ts
  - front-end/src/__tests__/signatureEvaluator.test.ts
  - front-end/src/__tests__/einsumShape.test.ts
---

# Build the graph-independent signature evaluator

## Objective

Evaluate a compiled v2 signature against ordered tensor inputs and parameters,
covering groups, patterns, output definitions, constraints and dtypes without
access to stereotype names or live graph state.

## Context required

- [Initiative plan](../plan.md), sections A-D and F.
- T01 schema and T02 expression contracts.
- Current algorithms in `front-end/src/conversion/typeEngine.ts:491-704`,
  `:1371-1775` and `:1799-1931`.

## Invariants

- The evaluator API accepts `CompiledTypeSignature`, ordered input types,
  normalized parameters, local/global bindings and generic capabilities only.
- It must not import `StereotypeCore`, `DiagramCore`, Svelte nodes or JSON.
- Local symbols share one signature application; globals share one root
  session.
- Output-pattern wildcard uses the first occurrence of the first group; other
  capture sources require `ComputedShape`.
- Einsum dispatches from `ShapeDefinition.kind` only.

## Allowed files

- Only the six paths in `write_scope`.

## Out of scope

- Topological traversal, live subflow application, production cutover and
  bundled JSON migration.

## Work

1. Implement deterministic group allocation and per-occurrence labels.
2. Port/fix matching for fixed, wildcard, scoped symbolic, parameter,
   parameter-spread and computed dimensions.
3. Ensure input computed dimensions are checked or rejected according to T01,
   and deferred computed dimensions compare structurally rather than always
   equal.
4. Resolve Pattern/Computed/Einsum outputs and explicit dtype expressions.
5. Evaluate constraints with optional messages/severity and preserve
   suggestions for unset parameter dimensions.
6. Move and clean the current Einsum equation evaluator; retain contracted and
   diagonal label checks and explicit unsupported-ellipsis diagnostics.
7. Add synthetic tests for every required dimension/group/expression behavior,
   including three-input Addition/Concat and positive MatMul.

## Acceptance criteria

- [ ] All required non-subflow test cases from the initiative are covered.
- [ ] A fabricated new stereotype signature evaluates without changing the
      evaluator.
- [ ] No Join action or ordinary stereotype name exists in implementation.
- [ ] Invalid constraints include declared messages and structured locations.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/signatureEvaluator.test.ts src/__tests__/einsumShape.test.ts
pnpm --dir front-end check
```

## Required handoff

Return evaluator API, files changed, commands/results, unresolved/deferred
semantics and any difference from current error messages.
