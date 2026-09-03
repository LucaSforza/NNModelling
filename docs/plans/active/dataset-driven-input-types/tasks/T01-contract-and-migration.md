---
id: T01
kind: task
status: ready
plan: ../plan.md
role: architecture
depends_on: []
parallel_with: []
write_scope:
  - stereotype-packages/core/input/
  - front-end/src/project-workspace/
  - front-end/src/type-system/graph/
  - front-end/src/core/
  - front-end/src/__tests__/
---

# Define the dataset-driven Input contract and one-way migration

## Objective

Establish one validated representation for parameterless top-level Inputs,
dataset dimension resolution and migration from legacy node and dataset data.

## Context required

- [Initiative](../plan.md)
- [Dataset-driven Input decision](../../../../knowledge/decisions/dataset-driven-input-types.md)
- `stereotype-packages/core/input/`
- `front-end/src/project-workspace/dataset-contract.ts`
- `front-end/src/type-system/graph/types.ts`
- diagram serialization/import code under `front-end/src/core/`

## Invariants

- Every used symbolic dimension maps to a same-named required integer dataset
  parameter and resolves to a positive integer.
- `B` resolves for training but remains the dynamic leading inference axis.
- Top-level and internal subflow Input semantics remain distinct.
- Migration is one-way; no permanent shape/dtype fallback remains.

## Allowed files

Only the paths in `write_scope`, with focused tests kept beside the affected
frontend contract.

## Out of scope

- Live UI integration, Python compilation, worker behavior and real training.
- A new expression language or dataset schema unrelated to dimension resolution.

## Work

1. Inventory current Input definitions, node persistence, named bindings,
   dataset validation and all active fixtures that encode Input tensor params.
2. Add failing tests for parameterless top-level Inputs and dataset symbol
   declaration/value validation.
3. Define the smallest resolved dataset-input structure shared by later tasks.
4. Implement deterministic one-way migration of legacy Input shape/dtype and
   dataset adapter metadata, rejecting ambiguous inputs instead of guessing.
5. Remove the legacy Input parameters and Lua-owned boundary typing only after
   migration coverage proves the supported path.

## Acceptance criteria

- [ ] `core.input` has no shape/dtype parameters.
- [ ] Dataset slot symbols require same-named required integer parameters and
      positive resolved values.
- [ ] Legacy supported examples have an explicit deterministic migration path.
- [ ] No permanent dual-source precedence remains.
- [ ] Internal subflow boundaries retain their existing contract.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/datasetContract.test.ts src/__tests__/namedGraphBindings.test.ts src/__tests__/diagramPersistence.test.ts
pnpm --dir front-end check
git diff --check
```

## Required handoff

Return files changed, schema and migration rules, exact test results, rejected
ambiguities, and the resolved contract T02/T03 must consume.
