---
id: T01
kind: task
status: draft
plan: ../plan.md
role: architecture
depends_on: []
parallel_with: []
write_scope:
  - front-end/src/type-system/model.ts
  - front-end/src/type-system/schema.ts
  - front-end/src/type-system/parameterValues.ts
  - front-end/src/__tests__/typeSchema.test.ts
---

# Freeze the v2 serialized contract and structural schema

## Objective

Produce an immutable, runtime-validated v2 type-signature model that represents
the redesigned UML, stores expressions as human-readable source strings and
rejects structurally malformed declarations before inference.

## Context required

- [Initiative plan](../plan.md), especially sections C, D and G.
- `front-end/src/conversion/tensortypes.ts:26-198`.
- `front-end/src/core/StereotypeCore.ts:16-143`.
- Current stereotype parameter declarations under `Stereotypes/`.

## Invariants

- `InputGroup` bounds describe input multiplicity, not a new tensor shape.
- `upper: null` is the only canonical unbounded representation.
- Symbol scope is explicit and structurally keyed.
- No Join/Subflow action vocabulary is part of v2.
- Expression fields contain non-empty source text, never serialized AST nodes.
- Schema compilation performs no graph inference and imports no Svelte/core
  graph types.
- Invalid and unset parameter values remain distinct.

## Allowed files

- Only the four paths in `write_scope`.
- New directories may be created under `front-end/src/type-system/`; do not
  modify the production loader or old engine in this task.

## Out of scope

- Expression parsing/type-checking/evaluation, pattern matching, graph traversal
  and JSON migration.
- Runtime fixes for incomplete Python module interfaces.

## Work

1. Resolve and encode the plan's four pre-ready decisions: constraint severity,
   unset spread semantics, anonymous-subflow contract and variadic allocation.
2. Define serialized and compiled discriminated unions for signatures, input
   groups, shape definitions, dimension patterns, constraints and dtype fields.
3. Define normalized parameter values and `unset | invalid | resolved` results
   without interpreting arbitrary Python code.
4. Implement a structural decoder from `unknown` with JSON-pointer diagnostics,
   bound checks, explicit dimension-parameter-reference checks and immutable
   output. Validate expression fields as non-empty strings; T02 owns their
   syntax, references and result types.
5. Reject multiple variable-width groups unless their partition is statically
   unique; initially reject more than one wildcard per pattern.
6. Add schema tests for every union member, bounds, scope, missing references,
   duplicate/ambiguous constructs and error paths.

## Acceptance criteria

- [ ] The public serialized model maps every target UML concept.
- [ ] `TypeConstraint` preserves current warning/error needs through the agreed
      severity metadata.
- [ ] Expression fields reject AST-shaped objects, empty strings and non-string
      values; T02 is the explicit gate for source syntax/result typing.
- [ ] Compiled signatures cannot be mutated through the raw JSON object.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/typeSchema.test.ts
pnpm --dir front-end check
```

## Required handoff

Return the exact human-readable v2 JSON contract, decisions taken for the four UML gaps,
changed files, validation results and any construct that still cannot be
represented without extending the model.
