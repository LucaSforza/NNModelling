---
id: T02
kind: task
status: draft
plan: ../plan.md
role: frontend
depends_on:
  - T01
parallel_with: []
write_scope:
  - front-end/src/expr/
  - front-end/src/type-system/schema.ts
  - front-end/src/__tests__/typeExpressions.test.ts
---

# Implement the shared typed expression core

## Objective

Extend NNModelling's existing human-readable expression parser, then compile
its source AST to one safe typed internal AST for dimension, shape, constraint
and dtype results. Include the generic collection and subflow operators needed
by bundled stereotypes without exposing AST-shaped JSON.

## Context required

- [Initiative plan](../plan.md), section D.
- T01 model/schema handoff.
- `front-end/src/expr/types.ts`, `parser.ts`, `evaluator.ts` and their tests.

## Invariants

- Canonical v2 expressions are readable source strings, never serialized AST
  data and never executable JavaScript.
- There is one parser, evolved from `front-end/src/expr/`, for all four result
  categories.
- Evaluation returns `value`, `deferred` or structured `error`; it never uses
  bare `undefined` as a catch-all.
- Every operator declares input and output kinds and is checked at load time.
- Operators are general language primitives and contain no stereotype names.
- `apply` and `iterate` call a capability supplied by context; they do not own a
  graph.

## Allowed files

- Existing and new files below `front-end/src/expr/`.
- `front-end/src/type-system/schema.ts` only for connecting structural decoding
  to expression compilation.
- `front-end/src/__tests__/typeExpressions.test.ts`.

## Out of scope

- Pattern matching, InputGroup allocation, Einsum equation parsing and live
  subflow traversal.

## Work

1. Extend the current tokenizer and recursive-descent parser with comparisons,
   boolean operators, `let`, shape/list and string literals, `param.name`, input
   references and restricted lambdas. Preserve current arithmetic, math calls,
   `$H` and `$*` syntax.
2. Define the shared source AST, typed internal AST and compiler that validates
   names, operator arity and expected result category against the T01 schema.
3. Extend the evaluator with tensor projection, normalized axes, shape
   slice/remove/replace/splice, collection map/sum/all/all-equal,
   boolean/control and dtype operations.
4. Add parameter scalar/list access with scalar broadcasting and `coalesce`.
5. Implement generic `apply` and `iterate` callbacks, trace propagation,
   recursion/iteration limits and memoization for repeated projections.
6. Compile expression fields during stereotype schema loading and report JSON
   path plus source span for syntax, name and type errors.
7. Add focused tests for source readability/backward-compatible arithmetic,
   all four result categories, deferred propagation, wrong-kind failures,
   collection binders and callback failures.

## Acceptance criteria

- [ ] Addition/Concat/Flatten/Unflatten/SequencePool expressions can be built
      entirely from generic operators.
- [ ] HorizontalRepeat and Repeat can be expressed with `apply`/`iterate` and
      no named operation primitive.
- [ ] Unknown operator, wrong arity and wrong result type fail compilation with
      a JSON path and source span.
- [ ] No stereotype fixture serializes an AST node; parse/print tests use source
      strings and the AST stays internal.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/typeExpressions.test.ts
pnpm --dir front-end check
```

## Required handoff

Return the grammar/operator table, changed files, validation results, complexity
limits and any old numeric source behavior deliberately not preserved.
