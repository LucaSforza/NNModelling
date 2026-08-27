---
id: T04
kind: task
status: ready
plan: ../plan.md
role: backend
depends_on: [T03]
parallel_with: [T05]
write_scope:
  - converted/src/package_worker.py
  - converted/src/dataset/
  - converted/src/backend/dataset_registry.py
  - converted/src/tests/test_package_worker.py
  - converted/src/tests/test_dataset_registry.py
---

# Train through the explicit objective program

## Objective

Normalize registered dataset batches and make the objective program the only
source of training loss.

## Context required

- [Accepted execution decision](../../../../knowledge/decisions/prediction-objective-programs.md)
- T03 compiled-program API handoff
- registered dataset discovery and current worker training loop

## Invariants

- Dataset classes are allowlisted and run only in the worker container.
- A batch has explicit inputs and targets at the trainer boundary.
- No default loss or inferred objective is permitted.
- Seed ordering, early stopping, device and normalized training configuration
  remain enforced.

## Work

1. Add failing tests showing logits without an objective are rejected rather
   than silently trained with Cross Entropy.
2. Add registered MNIST and autoencoder batch-contract tests, including target
   dtype and shape metadata validation.
3. Invoke only `compiled.objective(inputs, targets)` for train and validation.
4. Delete `_loss()` and every reachable shape/dtype/class fallback.
5. Delete `_run_legacy()`, `_load_legacy_package()` and the legacy trained ZIP
   writer after package-native worker tests cover the retained artifact
   invariants.
6. Reject missing targets, incompatible registered target specs and non-scalar
   final objectives before or at the first bounded validation batch.

## Acceptance criteria

- [ ] Cross Entropy and MSE behavior originates solely from package bindings.
- [ ] KL receives no accidental dataset target.
- [ ] No objective graph means a typed training validation error.
- [ ] `_loss()` and equivalent fallback logic are absent.
- [ ] `package_worker` has no legacy request or package-loading branch.

## Validation

```bash
cd converted && uv run pytest src/tests/test_package_worker.py src/tests/test_dataset_registry.py -q
```

## Required handoff

Return the normalized batch contract, deleted fallback paths, exact test results
and any dataset whose metadata remains insufficient.
