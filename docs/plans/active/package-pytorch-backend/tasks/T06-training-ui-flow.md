---
id: T06
kind: task
status: superseded
plan: ../plan.md
superseded_by: ../../package-backend-standard/tasks/P06-frontend-api.md
role: frontend
depends_on: [T02, T04]
parallel_with: [T05]
write_scope:
  - front-end/src/training/
  - front-end/src/components/TrainingSidebar.svelte
  - front-end/src/__tests__/trainingApi.test.ts
  - front-end/src/__tests__/trainingConnection.test.ts
---

# Connect the frontend training flow

## Objective

Enable the user to submit the current valid package graph, observe its
authenticated job lifecycle, cancel it, inspect logs and download the verified
result through the existing training connection.

## Context required

- [Initiative plan](../plan.md)
- Accepted T02 bundle contract and T04 API contract.
- `front-end/src/training/api.ts`
- `front-end/src/components/TrainingSidebar.svelte`
- `front-end/src/training/connection.ts`
- `front-end/src/Diagram.svelte.ts`
- `front-end/src/__tests__/trainingApi.test.ts`

## Invariants

- Pairing token handling and renewal remain unchanged and bearer headers are
  sent on every protected operation.
- Submit uses the browser's current `DiagramCore`/type result, not a copied
  graph or stale serialized state.
- Invalid/unresolved graphs and missing PyTorch entrypoints fail before upload.
- Event, log, cancellation and wheel digest verification behavior remains
  compatible with the existing API client.

## Allowed files

- Training client/transport modules, sidebar and the listed focused tests.

## Out of scope

- Backend endpoint or package compiler changes.
- MCP graph ownership or a second browser state store.

## Work

1. Add typed upload/package-job API methods and response/error models.
2. Implement `buildRequest()` from the current diagram, package exporter,
   training fields and resource policy.
3. Add clear UI states for bundle upload, queueing, package/runtime failure,
   cancellation and verified artifact download.
4. Test bearer auth, digest/error handling, package payloads, unresolved graphs
   and terminal SSE events.

## Acceptance criteria

- [ ] The training button submits a valid package graph and shows its job ID.
- [ ] The UI does not submit an invalid graph or fabricate a legacy NNTree.
- [ ] Status, logs, cancellation and verified download work through the current
      connection ownership model.
- [ ] Existing pairing and legacy API tests remain green.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/trainingApi.test.ts src/__tests__/trainingConnection.test.ts
pnpm --dir front-end check
```

## Required handoff

Return the exact request sequence, user-visible errors, changed files and any
API details that T07 must exercise through the real interface.
