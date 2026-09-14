---
id: T04
kind: task
status: done
plan: ../plan.md
role: review
depends_on: [T02, T03]
parallel_with: []
write_scope: []
---

# Review the integrated authoring boundary

## Objective

Read the combined diff and identify contract mismatches, ownership violations,
unsafe deletion or missing regression coverage before QA.

## Acceptance criteria

- [x] Tool schemas and browser RPC payloads agree field-for-field.
- [x] UI and RPC share domain operations.
- [x] Destructive paths are exact, non-cascading and rollback-safe.
- [x] No tests or live workflows are executed.

## Validation

Read-only diff inspection only. Return findings to T02 or T03 owners.
