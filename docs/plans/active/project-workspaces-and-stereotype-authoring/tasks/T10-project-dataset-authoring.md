---
id: T10
kind: task
status: blocked
plan: ../plan.md
role: frontend
depends_on: [T07]
parallel_with: [T08, T09]
write_scope:
  - front-end/src/dataset-authoring/
  - front-end/src/project-workspace/
  - front-end/src/components/
  - front-end/src/__tests__/
---

# Author project-owned datasets

## Objective

Add a Datasets manager that creates a complete project dataset directory from
structured forms and commits its exhaustive manifest entry transactionally.

## Invariants

- All source/data paths remain under the dataset directory; symlinks and
  external references are rejected.
- Parameters and named slots serialize T07 schemas directly.
- Generated Python is an editable, non-toy example of the fixed builder,
  context, splits and named batch contract.
- Dataset creation uses the same ordered project writer and rollback discipline
  as stereotype creation.

## Work

1. Add identity, metadata, parameter, input-slot, target-slot and class forms.
2. Generate `manifest.json`, `dataset.json`, `dataset.py` and `data/`.
3. Provide an instructive basic `.pt` split-loader scaffold without making that
   file format a hidden requirement.
4. Add project-local data-file selection/copy with size feedback.
5. Test validation, manifest update, reopen and exact-directory rollback.

## Acceptance criteria

- [ ] The manager lists built-ins read-only and current-project datasets.
- [ ] A created dataset reopens with identical definitions and files.
- [ ] Duplicate IDs/slots, invalid contracts and path escape fail pre-mutation.
- [ ] Failure cannot remove or alter a pre-existing directory.

## Required handoff

Report the form model, generated tree/template, transactional boundaries and
reopen/failure evidence.
