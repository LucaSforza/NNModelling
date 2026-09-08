---
id: T09
kind: task
status: blocked
plan: ../plan.md
role: backend
depends_on: [T07]
parallel_with: [T08, T10]
write_scope:
  - converted/src/dataset/
  - converted/src/backend/dataset_registry.py
  - converted/src/backend/models.py
  - converted/src/tests/
---

# Migrate built-in datasets to the shared contract

## Objective

Represent MNIST, AutoencoderMNIST and Enron with the same declarative metadata,
parameters, named batches and builder interface used by project datasets.

## Invariants

- Built-ins remain trusted worker-image resources and may use operator data.
- FastAPI reads declarative descriptors; it does not inspect constructors.
- Training requests no longer expose Python import targets.
- Existing split, batching and class metadata behavior is preserved.

## Work

1. Add manifests/definitions and fixed builders for all built-ins.
2. Replace signature introspection with descriptor validation and opaque refs.
3. Normalize every DataLoader item to named `TrainingBatch` maps.
4. Preserve current parameters, split behavior and useful diagnostics.
5. Add descriptor, loader and regression tests for all three datasets.

## Acceptance criteria

- [ ] One registry response shape describes built-in and future project entries.
- [ ] Every built-in passes its current functional coverage after migration.
- [ ] No public request contains a Python module/class target.
- [ ] Built-in trust does not weaken the worker-only rule for project code.

## Required handoff

Report descriptor examples, old-to-new parameter mapping, batch slots and exact
regression evidence.
