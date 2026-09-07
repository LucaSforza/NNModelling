---
id: T03
kind: task
status: done
plan: ../plan.md
role: frontend
depends_on: []
parallel_with: [T01, T02]
write_scope:
  - front-end/src/training/api.ts
  - front-end/src/training/controller.ts
  - front-end/src/components/TrainingSidebar.svelte
  - front-end/src/styles/training-sidebar.css
  - front-end/src/__tests__/trainingApi.test.ts
  - front-end/src/__tests__/trainingController.test.ts
---

# Build the connection-aware W&B frontend

## Objective

Expose the approved administrator-owned W&B capability to browser users with
typed mode/project controls, structured run links, and verified offline download.

## Context required

- Read the [initiative](../plan.md), `front-end/AGENTS.md`, current training API,
  controller, sidebar, and their tests.
- Treat the capability, structured `wandb_run`, SSE, and offline endpoint shapes
  in the plan as frozen even while backend tasks run.

## Invariants

- The browser never asks for, stores, sends, or displays an API key.
- Entity/base URL are read-only administrator-owned status; the user controls
  only project and mode.
- Online is not selectable when capability says unavailable and no mode silently
  changes during submission.
- Offline download verifies `X-NNM-SHA256` before saving.
- Existing training connection, bundle upload, job logs, cancellation, and wheel
  download remain unchanged.

## Allowed files

Only the files in `write_scope`. Do not change browser RPC or graph behavior.

## Out of scope

- Backend/controller implementation, credential administration, general UI
  redesign, W&B Artifact upload, and unrelated training settings.

## Work

1. Add exact TypeScript capability/run contracts and API methods.
2. Load capability after backend connection and keep it in controller state.
3. Replace the free-text mode input with a typed select, show sanitized
   connection/entity/base-URL state, and make unavailable online mode explicit.
4. Consume structured `wandb_ready`, open online URLs, and download/digest-check
   offline archives.
5. Remove all use of the standalone `wandb_url` field.
6. Add focused Vitest coverage for capability, submission, SSE, and digest
   verification behavior.

## Acceptance criteria

- [ ] No key-shaped frontend state or request field exists.
- [ ] Mode availability and failure behavior match the plan exactly.
- [ ] Online links and offline downloads use only the structured run contract.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/trainingApi.test.ts src/__tests__/trainingController.test.ts
pnpm --dir front-end check
```

## Required handoff

Return changed files, exact commands/results, assumptions, and any backend shape
mismatch discovered during implementation.
