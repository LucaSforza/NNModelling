---
id: T07
kind: task
status: blocked
plan: ../plan.md
role: architecture
depends_on: [T06]
parallel_with: []
write_scope:
  - front-end/src/project-workspace/
  - front-end/src/training/
  - converted/src/dataset/
  - converted/src/backend/models.py
  - front-end/src/__tests__/
  - converted/src/tests/
---

# Freeze dataset and named-batch contracts

## Objective

Implement the shared serialization boundary before parallel dataset work:
manifest schema v2, dataset manifest/definition schemas, declarative parameters,
flat named tensor slots, opaque dataset references and compatibility reads for
schema v1.

## Invariants

- T06 must have passed; blocked status cannot be removed speculatively.
- Schema v1 reads as an empty dataset list and upgrades on the next successful
  write; there is one release-path interpretation after migration.
- Browser and FastAPI validate declarations without importing project Python.
- Slot order, Python signatures and display labels never infer bindings.

## Work

1. Define versioned frontend/backend schemas and canonical validation errors.
2. Add `customDatasets` to manifest v2 with confined relative paths.
3. Define dataset identity, parameters, batch slot tensor contracts and opaque
   built-in/project references.
4. Define the normalized worker `TrainingBatch` and builder/context interfaces.
5. Add round-trip, v1-upgrade, unknown-field and invalid-path/slot tests.

## Acceptance criteria

- [ ] Frontend/backend fixtures serialize identically.
- [ ] Invalid paths, duplicate slots, unsupported dtypes and unknown versions
      fail before persistence or execution.
- [ ] Existing schema-v1 projects open and upgrade without losing packages.
- [ ] T08-T11 consume these types rather than creating private variants.

## Required handoff

Report the frozen schemas, migration behavior, validation evidence and any
compatibility decision that downstream tasks must preserve.
