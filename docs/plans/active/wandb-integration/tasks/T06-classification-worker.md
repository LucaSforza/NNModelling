---
id: T06
kind: task
status: done
plan: ../plan.md
role: backend
depends_on: [T05]
parallel_with: []
write_scope:
  - converted/src/package_worker.py
  - converted/src/tests/test_package_worker.py
---

# Compute classification metrics in the package worker

## Objective

Use the selected dataset's existing `classes` metadata and explicit
`CompiledPrograms.prediction()` view to publish transformer-parity W&B
classification telemetry and elapsed time, while preserving loss-only training
for every other dataset.

## Context required

- Read the [initiative](../plan.md), [project-owned datasets](../../../../knowledge/decisions/project-owned-datasets.md), [prediction/objective programs](../../../../knowledge/decisions/prediction-objective-programs.md), `package_worker.py`, and `T05`.
- Inspect the standalone transformer's metric definitions as the product
  reference, not as code to import or duplicate wholesale.

## Invariants

- `model.objective(inputs, targets)` remains the sole training loss path.
- `model.prediction(inputs)` is used only after classification metadata and
  declared target/logit contracts have passed deterministic preflight checks.
- No metric detection may select a loss, package, output or target by ID,
  display name, Python type or objective signature.
- The worker keeps its isolation, artifact, early-stopping and seed behavior.

## Work

1. Add a small internal classification specification/accumulator derived from
   `DatasetDefinition.classes`, its sole target slot and the frozen shape/dtype
   rules in the initiative.
2. During train and validation, calculate loss as now and collect predictions
   from the prediction program; compute accuracy, binary and macro metrics plus
   the integer confusion matrix without third-party metric dependencies.
3. Evaluate the test loader after the epoch loop only for classification,
   measure whole-training elapsed seconds with a monotonic clock, and pass the
   result to `T05`'s tracker API.
4. Keep `training-summary.json` useful by adding classification/test/timing
   data only for classified jobs.
5. Cover binary one-hot and class-index targets, multiclass macro behavior,
   invalid class contracts/logits, and the non-classification loss-only path.

## Acceptance criteria

- [ ] The transformer dataset's existing `classes` metadata yields its complete
      epoch and final W&B metric set, including labels `ham` and `spam`.
- [ ] A dataset without `classes` never invokes `prediction()` for telemetry
      and retains its current summary/history shape.
- [ ] Ambiguous or incompatible classification declarations fail before an
      epoch is trained with a clear validation error.

## Validation

```bash
cd converted && uv run pytest src/tests/test_package_worker.py src/tests/test_wandb_tracking.py -q
cd converted && uv run pytest src/tests/ -m fast -q
```

## Required handoff

Return files changed, commands/results, contract failures covered, and any
knowledge document made inaccurate.
