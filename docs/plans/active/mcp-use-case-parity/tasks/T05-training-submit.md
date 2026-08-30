---
id: T05
kind: task
status: draft
plan: ../plan.md
role: integration
depends_on: [T04]
parallel_with: []
write_scope:
  - front-end/src/training/
  - front-end/src/components/TrainingSidebar.svelte
  - front-end/src/sync/BrowserRPCHandler.ts
  - front-end/src/__tests__/
  - mcp-server/src/tools/remote-training.ts
  - mcp-server/__tests__/
---

# Train the active project snapshot

## Objective

Satisfy T3 without requiring the agent to assemble job JSON or upload the model out of band.

## Context required

Read the [initiative plan](../plan.md), its source links and the
[accepted UML](../../../../knowledge/uml/mcp-use-case-parity.md).

Inspect TrainingSidebar `buildRequest`/`submit`, `buildPackageBundle`, diagram.packageExports, runtime readiness and backend package-bundle/job contracts.

## Invariants

Only the active committed project/package scope is exported. Graph, configuration and resource closure describe one snapshot. Backend owns execution and submission validation.

## Allowed files

- `front-end/src/training/`
- `front-end/src/components/TrainingSidebar.svelte`
- `front-end/src/sync/BrowserRPCHandler.ts`
- `front-end/src/__tests__/`
- `mcp-server/src/tools/remote-training.ts`
- `mcp-server/__tests__/`

Directory scopes permit only changes serving this task. Narrow them to the
actual files in the handoff; do not reorganize unrelated modules.

## Out of scope

No Python compiler, wheel exporter, backend scheduler or dataset migration. If an HTTP contract is actually missing, return a bounded follow-up proposal instead of widening this task.

## Work

1. Move request building to the shared controller/service and route Sidebar and start_training through it. Keep UI popup/window effects in Sidebar, not in the shared operation.
2. Validate selected session/configuration and runtime readiness, then capture a consistent graph/resource/config snapshot. Detect project/backend changes across asynchronous preparation and abort rather than mix owners or resources.
3. Reuse buildPackageBundle and packageExports for core plus active model-custom dependency closure and adapters. Upload via the paired API and verify the returned bundle digest before submitting.
4. Return job ID, backend/owner-safe identity and bundle digest. Reflect the submitted job in Sidebar without creating another job store or issuing duplicate POSTs.
5. Test invalid configuration, missing package resources, upload/digest failure, authorization expiry and project switch. A failed upload sends no job; ambiguous POST failure reports uncertainty without blind retry.

## Acceptance criteria

- [ ] An agent can train the visible project using only its chosen configuration.
- [ ] The backend receives the same canonical graph/configuration as sidebar submission.
- [ ] Custom package resources and adapter selections survive export.
- [ ] Failures preserve the editor and do not silently create duplicate or wrong-owner jobs.
- [ ] No changes outside the declared write scope.

## Validation

Run from the repository root. Extend the listed tests for the new behavior;
passing unchanged proxy mocks alone is not proof of this task.

```bash
pnpm --dir front-end exec vitest run src/__tests__/trainingApi.test.ts src/__tests__/BrowserRPCHandler.test.ts
pnpm --dir front-end check
pnpm --dir mcp-server test
```

Add focused shared-submission tests covering the failure matrix. Through public MCP, submit one explicitly authorized tiny type-valid package project to the existing backend and compare the received job/bundle identity with the UI. Do not provision compute automatically.

## Required handoff

Return changed files, exact checks/results, observed user-facing behavior,
resolved assumptions, remaining blockers and affected KB statements. Keep
credentials out of evidence. Update this task's status in its own file; the
initiative plan owns overall status.

