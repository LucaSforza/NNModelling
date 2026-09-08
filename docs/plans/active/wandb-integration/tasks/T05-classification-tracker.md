---
id: T05
kind: task
status: done
plan: ../plan.md
role: backend
depends_on: [T01]
parallel_with: []
write_scope:
  - converted/src/training/wandb_tracking.py
  - converted/src/tests/test_wandb_tracking.py
---

# Add a classification-aware W&B tracker API

## Objective

Extend the package-worker-only tracker so it can record the established
classification metric set and final W&B confusion-matrix panel, while retaining
the exact loss-only path for non-classification and disabled runs.

## Context required

- Read the [initiative](../plan.md), the [remote-training architecture](../../../../knowledge/architecture/remote-training.md), and `wandb_tracking.py`.
- Treat the package worker as the source of metric values; this task must not
  inspect batches, models, datasets, package IDs, or objectives.

## Invariants

- Disabled tracking must not import or initialize the W&B SDK.
- Offline and online credential, network, manifest and secret-redaction
  contracts remain unchanged.
- Metric keys, class labels and confusion-matrix orientation are frozen by the
  initiative; tracker inputs must be finite JSON/W&B-safe values.

## Work

1. Introduce narrow typed/value-validated tracker methods for epoch metrics and
   final classification metrics, including a W&B native confusion-matrix plot.
2. Preserve `log_epoch` loss semantics for callers without classification data.
3. Store the final metrics, raw matrix, convention, labels and parameter count
   in the W&B summary, without putting these into the backend run manifest.
4. Add fake-SDK regression tests for binary and multiclass logs, matrix labels,
   disabled behavior and malformed metric rejection.

## Acceptance criteria

- [ ] The tracker emits the loss keys on every epoch and classification keys
      only when explicitly supplied by the worker.
- [ ] The final classification payload produces one labelled W&B confusion
      matrix and the documented summary values.
- [ ] Existing online/offline manifest and credential tests still pass.

## Validation

```bash
cd converted && uv run pytest src/tests/test_wandb_tracking.py -q
```

## Required handoff

Return files changed, commands/results, any assumption about W&B SDK plotting,
and any knowledge document made inaccurate.
