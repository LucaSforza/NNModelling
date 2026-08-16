---
id: T10
kind: task
status: draft
plan: ../plan.md
role: review
depends_on:
  - T08
parallel_with:
  - T09
write_scope:
  - front-end/src/expr/
  - front-end/src/core/StereotypeCore.ts
  - front-end/src/__tests__/expr.test.ts
  - front-end/src/__tests__/stereotypeLoadErrors.test.ts
  - front-end/src/__tests__/typeArchitecture.test.ts
---

# Remove legacy expression paths and enforce the architecture

## Objective

Eliminate obsolete action and duplicate numeric-evaluation paths while keeping
the evolved human-readable DSL as the single authority. Add regression checks
that make ordinary stereotype-name hardcoding or unvalidated expressions fail
CI.

## Context required

- [Initiative plan](../plan.md), sections B, D.6 and F.
- T08 cutover diff and T02 expression handoff.
- Current `front-end/src/expr/` tests and loader behavior.

## Invariants

- Keep one human-readable parser, typed AST and evaluator authority.
- The AST is internal and no serialized expression may depend on its shape.
- The architecture guard may allow the `einsum` shape discriminant, but not a
  stereotype name comparison.
- Tests should enforce dependency boundaries, not merely scan comments for
  words.

## Allowed files

- Only the five paths in `write_scope`; consolidating obsolete files below
  `front-end/src/expr/` is allowed, but the source-language parser remains.

## Out of scope

- New typing behavior, Join UI and documentation.

## Work

1. Trace remaining imports and consolidate the evolved tokenizer/parser,
   compiler and evaluator into one path. Delete only fallback evaluators and
   temporary compatibility branches; do not delete the readable DSL.
2. Add load-time regressions for malformed operators, wrong result types,
   missing parameters and malformed legacy numeric text.
3. Add architecture tests that reject generic-evaluator imports of
   `StereotypeCore`/graph state and reject legacy action fields in production
   schema/code.
4. Add a synthetic new stereotype test and renamed-Einsum tests proving semantic
   independence from names.
5. Review TypeEngine/type-system source for parameter-specific strategies and
   record any allowed general primitive explicitly.

## Acceptance criteria

- [ ] There is one evaluator authority.
- [ ] Expression JSON contains source strings and still round-trips through the
      single parser/compiler without exposing internal AST nodes.
- [ ] Invalid expression declarations fail during loading.
- [ ] Architecture tests fail on a representative reintroduced name/action
      branch.
- [ ] A never-before-seen declarative stereotype works without engine changes.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/stereotypeLoadErrors.test.ts src/__tests__/typeArchitecture.test.ts
pnpm --dir front-end check
pnpm --dir front-end test
```

## Required handoff

Return removed paths, guard design, intentional exceptions, exact test results
and any residual compatibility code with a removal condition.
