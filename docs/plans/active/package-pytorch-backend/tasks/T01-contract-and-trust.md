---
id: T01
kind: task
status: superseded
plan: ../plan.md
superseded_by: ../../package-backend-standard/tasks/P01-contract-and-legacy-removal.md
role: architecture
depends_on: []
parallel_with: []
write_scope:
  - docs/plans/active/package-pytorch-backend/tasks/T01-contract-and-trust.md
  - docs/knowledge/decisions/
---

# Settle package protocol and trust boundary

## Objective

Produce an accepted v1 contract for the package bundle, package-job payload,
runtime compatibility, package trust policy and container boundary. Record only
decisions explicitly accepted by the project owner; unresolved alternatives
remain visible.

## Context required

- [Initiative plan](../plan.md)
- [Frontend package contract](../../../../knowledge/contracts/package-type-system.md)
- [Remote-training architecture](../../../../knowledge/architecture/remote-training.md)
- `front-end/src/type-system/packages/types.ts`
- `stereotype-packages/core/*/manifest.json`
- `converted/src/backend/models.py`
- `converted/backend/docker-compose.yml`

## Invariants

- Lua is the frontend inference authority; PyTorch is a backend execution
  entrypoint only.
- Exact package IDs/versions and target-handle ordering are semantic data.
- The browser cannot choose a backend filesystem path or silently authorize
  arbitrary Python.
- Existing `nntree` jobs remain a distinct compatibility variant.

## Allowed files

- This task file while refining the draft.
- A narrow durable decision document under `docs/knowledge/decisions/` after
  owner acceptance.

## Out of scope

- Implementing the exporter, Python runtime, API or container executor.
- Marking proposed trust or GPU/network policy as agreed without acceptance.

## Work

1. Define the canonical bundle manifest, graph representation, resource limits,
   digest rules, size limits and dependency closure behavior.
2. Choose streamed archive versus structured JSON transport and decide whether
   package sources are bundled-only, administrator-approved or user-uploadable.
3. Define CPU acceptance criteria and explicitly defer or specify GPU behavior.
4. Define the worker/runtime contract for `BuildContext`,
   `StereotypeServices` and `SubflowServices`.
5. Record the accepted boundary in the narrowest knowledge decision document.

## Acceptance criteria

- [ ] Every field needed by T02–T05 has an owner and validation rule.
- [ ] Trust, upload, dataset, network, container and GPU policies are explicit.
- [ ] No unresolved high-risk choice is hidden in a task as an implementation
      detail.

## Validation

```bash
git diff --check
```

## Required handoff

Return the accepted decisions, unresolved questions, changed knowledge files
and the exact protocol examples used by the frontend and backend tasks.
