---
id: T04
kind: task
status: ready
plan: ../plan.md
role: frontend
depends_on: [T03]
parallel_with: []
write_scope:
  - front-end/src/FlowCanvas.svelte
  - front-end/src/components/TrainingSidebar.svelte
  - front-end/src/training/
  - front-end/src/sync/BrowserRPCHandler.ts
  - front-end/src/__tests__/
  - mcp-server/src/server.ts
  - mcp-server/src/tools/remote-training.ts
  - mcp-server/__tests__/
---

# Share backend connection and complete training configuration

## Objective

Satisfy T1–T2 through a shared browser training session available independently of sidebar visibility.

## Context required

Read the [initiative plan](../plan.md), its source links and the
[accepted UML](../../../../knowledge/uml/mcp-use-case-parity.md).

Inspect TrainingSidebar connection lifecycle and all form fields, `training/connection.ts`, TrainingApiClient, RefreshGate, FlowCanvas lifecycle and the frozen T01 routing contract.

## Invariants

The controller is scoped to the editor/project, not a global singleton or second scheduler. Backend tokens stay private. Pairing approval and revocation are not bypassed.

## Allowed files

- `front-end/src/FlowCanvas.svelte`
- `front-end/src/components/TrainingSidebar.svelte`
- `front-end/src/training/`
- `front-end/src/sync/BrowserRPCHandler.ts`
- `front-end/src/__tests__/`
- `mcp-server/src/server.ts`
- `mcp-server/src/tools/remote-training.ts`
- `mcp-server/__tests__/`

Directory scopes permit only changes serving this task. Narrow them to the
actual files in the handoff; do not reorganize unrelated modules.

## Out of scope

No job submission implementation yet, backend approval automation, persisted project-format changes or dataset authoring.

## Work

1. Extract minimal reusable connection/configuration behavior into the browser training area. FlowCanvas owns its lifecycle and passes it to Sidebar and RPC; sidebar close must not destroy it.
2. Expose connect/status/renew/forget/revoke according to T01. Return pending and verification information promptly, distinguish expiry/rejection/revocation and clean up stale timers/readers.
3. Define one canonical typed configuration with shared validation and serializer. Wire every field in the plan inventory, including dynamic dataset parameters and optional resource selectors.
4. Implement inspect and atomic validated configuration updates. Reflect MCP changes in the UI and UI changes in MCP, including defaults and optional-field clearing.
5. Preserve existing connection restoration policy; do not invent configuration persistence or expose filesystem handles. Prevent late callbacks from a previous tab/project/backend overwriting current state.
6. Add a field-coverage test tied to actual sidebar controls/descriptor keys so future added fields cannot silently escape MCP parity. Preserve or explicitly migrate existing HTTP tools only under T01's approved contract.

## Acceptance criteria

- [ ] Connection lifecycle is usable through MCP without administrator credentials.
- [ ] Every sidebar field round-trips with the same meaning and validation.
- [ ] Sidebar close/reopen does not reset the MCP configuration or connection.
- [ ] Cross-project/session stale responses are rejected; outputs contain no token.
- [ ] No changes outside the declared write scope.

## Validation

Run from the repository root. Extend the listed tests for the new behavior;
passing unchanged proxy mocks alone is not proof of this task.

```bash
pnpm --dir front-end exec vitest run src/__tests__/trainingConnection.test.ts src/__tests__/trainingApi.test.ts src/__tests__/BrowserRPCHandler.test.ts
pnpm --dir front-end check
pnpm --dir mcp-server test
```

Add controller/field-coverage tests alongside existing suites. In the real editor, request pairing, have the authorized operator approve it, modify every control through MCP and UI, and test sidebar reopen. Use a disposable session for revoke/expiry checks.

## Handoff status

The shared editor-scoped training controller and typed configuration seam are
implemented by `39940da`. Live pairing approval, every-field round-trip and
closed-sidebar verification remain pending. T05 owns snapshot submission; the
legacy process-authenticated MCP tools remain a separate compatibility route.

## Required handoff

Return changed files, exact checks/results, observed user-facing behavior,
resolved assumptions, remaining blockers and affected KB statements. Keep
credentials out of evidence. Update this task's status in its own file; the
initiative plan owns overall status.
