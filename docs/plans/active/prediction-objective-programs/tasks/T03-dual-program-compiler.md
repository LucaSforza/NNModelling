---
id: T03
kind: task
status: ready
plan: ../plan.md
role: backend
depends_on: [T01]
parallel_with: [T02]
write_scope:
  - converted/src/package_runtime/
  - converted/src/stereotype_runtime/
  - converted/src/tests/test_package_runtime.py
---

# Compile shared prediction and objective programs

## Objective

Return two executable programs over one compiled module store, driven only by
package roles, graph topology and declared external inputs.

## Context required

- [Accepted execution decision](../../../../knowledge/decisions/prediction-objective-programs.md)
- T01 schema handoff
- current `package_runtime/compiler.py` and loader validation

## Invariants

- Package Python remains worker-only.
- A module is built once per graph node and parameters are registered once.
- Prediction never enters the objective region or requires a target.
- Objective operands preserve handle order; external inputs follow declaration
  order.
- No package-ID, display-name, PyTorch-class, shape/dtype or signature dispatch.

## Work

1. Add failing tests for program partitioning and shared parameter identity.
2. Add Cross Entropy and MSE target-binding tests and KL no-target tests.
3. Add a composite MSE-plus-KL objective and ordered scalar join test.
4. Add renamed-package anti-hardcoding tests, binding cardinality tests and
   typed failures for disconnected or ambiguous program regions.
5. Introduce a compiled-program container with one module store and explicit
   prediction/objective entrypoints.
6. Remove signature inspection, input-as-target fallback and loss-class cases.

## Acceptance criteria

- [ ] `prediction(inputs)` works without targets for graphs containing losses.
- [ ] `objective(inputs, targets)` returns the declared scalar objective.
- [ ] Both views expose identical parameter objects, with no duplicate state
      keys.
- [ ] Nested subflows and ordered joins remain covered.
- [ ] Searches find no objective routing through package IDs, `isinstance` or
      `inspect.signature`.

## Validation

```bash
cd converted && uv run pytest src/tests/test_package_runtime.py -q
```

## Required handoff

Return the public compiled-program API, state-dict behavior, exact test results
and any bundle validation required from T02.
