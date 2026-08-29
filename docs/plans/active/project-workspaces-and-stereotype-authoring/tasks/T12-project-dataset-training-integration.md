---
id: T12
kind: task
status: blocked
plan: ../plan.md
role: integration
depends_on: [T08, T09, T10, T11]
parallel_with: []
write_scope:
  - front-end/src/components/TrainingSidebar.svelte
  - front-end/src/training/
  - converted/src/backend/
  - converted/src/training/
  - converted/src/tests/
  - front-end/src/__tests__/
  - mcp-server/
---

# Integrate project datasets with training

## Objective

Let each job select a built-in or current-project dataset, upload when needed,
preflight named bindings and execute the fixed dataset loader in the isolated
worker.

## Invariants

- Upload completion and job submission are separate commits.
- Jobs persist exact dataset ID, version, digest and normalized parameters.
- Project code failures are worker-scoped; no host/FastAPI fallback exists.
- Browser and MCP use the same backend job and dataset contracts.

## Work

1. Merge built-in and active-project descriptors in the training selector.
2. Render canonical parameter forms and show archive limit/progress.
3. Preflight graph/objective bindings against the selected dataset.
4. Resolve built-ins directly or upload/reuse a project archive before submit.
5. Load/normalize batches in the worker and move tensors to its device.
6. Add built-in, project, multiple-input, autoregressive and injected-failure
   integration coverage, including authenticated MCP parity.

## Acceptance criteria

- [ ] Both dataset sources follow one visible selection/submission workflow.
- [ ] Incompatible slots fail before a job starts.
- [ ] Valid project code imports only after the worker launches.
- [ ] Upload, submission and worker failures have distinct recoverable states.
- [ ] Completed job metadata contains exact immutable dataset identity.

## Required handoff

Report supported journeys, persisted job metadata, execution-boundary proof,
failure semantics and integration results.
