---
id: T03
kind: task
status: ready
plan: ../plan.md
role: backend
depends_on: [T02]
parallel_with: []
write_scope:
  - front-end/src/training/
  - converted/src/
  - converted/backend/
---

# Compile dataset-instantiated models and export autonomous wheels

## Objective

Carry the resolved named input contract through bundle validation, compilation,
training, checkpoint compatibility and dataset-independent wheel inference.

## Context required

- [Initiative](../plan.md)
- T01 handoff and resolved dataset-input contract
- [Portable model-package contract](../../../../knowledge/contracts/model-package.md)
- package bundle, compiler, worker, trainer and model-package runtime

## Invariants

- FastAPI never imports project dataset or package Python.
- No unresolved symbolic dimension reaches compilation.
- Wheel inference requires no dataset or target.
- Exported batch dimension remains dynamic.
- Existing selected wheel adapters are reused; no second adapter mechanism.
- Checkpoint and state loading remain strict.

## Allowed files

Only training bundle code and converted backend/runtime/tests in `write_scope`.

## Out of scope

- Editor controls, VAE fixture migration and broad integration cleanup.

## Work

1. Trace the resolved contract from browser bundle creation through worker
   compilation, execution fingerprinting, training and wheel export/runtime.
2. Add failing tests for unresolved symbols, dataset changes, structural state
   incompatibility, dynamic exported batches and multiple named inputs.
3. Materialize dataset-resolved Input tensors before package graph compilation.
4. Freeze named input shapes/dtypes and selected adapters into wheel metadata
   without copying dataset resources or runtime parameters.
5. Support named multiple-input `predict_tensor`; retain the tensor convenience
   form only for exactly one binding.
6. Prove public inference in a clean temporary environment.

## Acceptance criteria

- [ ] Training compiles only a fully resolved dataset-scoped graph.
- [ ] Dataset changes cannot reuse stale inference or incompatible state.
- [ ] Wheel metadata has a complete named input contract and no dataset payload.
- [ ] Inference batch size is dynamic.
- [ ] Single- and multiple-input public APIs are tested.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test
cd converted && uv run pytest src/tests/test_package_runtime.py src/tests/test_package_worker.py src/tests/test_model_package.py -q
cd converted && uv run pytest src/tests/ -m fast -q
git diff --check
```

## Required handoff

Return files changed, transported/resolved schema, fingerprint behavior,
clean-wheel commands/results and integration assumptions for T05.
