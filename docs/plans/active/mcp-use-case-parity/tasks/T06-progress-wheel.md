---
id: T06
kind: task
status: ready
plan: ../plan.md
role: integration
depends_on: [T05]
parallel_with: []
write_scope:
  - front-end/src/training/
  - front-end/src/components/TrainingSidebar.svelte
  - front-end/src/sync/BrowserRPCHandler.ts
  - front-end/src/__tests__/
  - mcp-server/src/tools/remote-training.ts
  - mcp-server/src/remote-training.ts
  - mcp-server/src/server.ts
  - mcp-server/__tests__/
---

# Monitor jobs and retrieve verified wheels

## Objective

Satisfy T4–T5 with bounded progress reads and an actual usable artifact.

## Context required

Read the [initiative plan](../plan.md), its source links and the
[accepted UML](../../../../knowledge/uml/mcp-use-case-parity.md).

Inspect SseParser, subscribeTrainingEvents, tailTrainingJobLogs, downloadModelPackage, MCP getEvents and backend ownership/download routes. Follow T01's artifact and compatibility contracts.

## Invariants

Progress is read from backend state. Event and stdout/stderr cursors remain distinct. Download trusts the owned manifest and verifies header plus bytes; no token is returned.

## Allowed files

- `front-end/src/training/`
- `front-end/src/components/TrainingSidebar.svelte`
- `front-end/src/sync/BrowserRPCHandler.ts`
- `front-end/src/__tests__/`
- `mcp-server/src/tools/remote-training.ts`
- `mcp-server/src/remote-training.ts`
- `mcp-server/src/server.ts`
- `mcp-server/__tests__/`

Directory scopes permit only changes serving this task. Narrow them to the
actual files in the handoff; do not reorganize unrelated modules.

## Out of scope

No new scheduler, public artifact URLs, credential-sharing workaround, cloud storage service or unlimited transfer framework.

## Work

1. Add bounded incremental progress reads with cursor continuation, terminal state, available metrics, diagnostics and log chunks. Reuse parsers/API seams; remove response.text()-until-EOF behavior from the affected MCP event path.
2. Cap wait and response sizes; cancel readers on timeout or disconnect without cancelling the job implicitly. Preserve cursor/reset semantics, explicit cancellation and ownership failures.
3. For download, fetch the owned job manifest and use the existing integrity-checked bytes path. Distinguish unavailable artifact, exporter failure, malformed/mismatched digest and authorization failure.
4. Implement the single artifact delivery route frozen by T01. A reported success must identify a retrievable verified file and digest. Apply transfer limits and non-overwriting destination policy; partial/corrupt files must never appear as successful artifacts.
5. Retain useful existing status/list/cancel tools and make connection provenance clear. Do not silently combine environment-token jobs with the selected browser owner's jobs.
6. Add open-SSE, chunk boundary, reconnect/cursor, empty-log, timeout, cancelled-job, wrong-owner and corrupted-download tests.

## Acceptance criteria

- [ ] Progress arrives while a stream is still open and reads finish within the specified bound.
- [ ] Repeated reads can continue without skipping events or conflating log cursors.
- [ ] The agent retrieves real wheel bytes; manifest-only and inaccessible Blob URLs fail acceptance.
- [ ] Digest mismatch and wrong-owner access return errors without publishing an artifact.
- [ ] No changes outside the declared write scope.

## Validation

Run from the repository root. Extend the listed tests for the new behavior;
passing unchanged proxy mocks alone is not proof of this task.

```bash
pnpm --dir front-end exec vitest run src/__tests__/trainingApi.test.ts
pnpm --dir front-end check
pnpm --dir mcp-server test
```

## Implementation handoff

The bounded progress and verified wheel paths are implemented. End-to-end
monitoring and wheel retrieval against a T05-owned running job remain an
external verification gate: no authorized live job/session was available in
this worktree. The implementation deliberately does not manufacture a token,
job, or artifact to satisfy that gate.

Monitor T05's authorized job before completion, then retrieve its wheel through MCP and independently verify the digest. Use test-owned sessions/artifacts for negative cases. Artifact installation and public Model smoke testing are required in T07.

## Required handoff

Return changed files, exact checks/results, observed user-facing behavior,
resolved assumptions, remaining blockers and affected KB statements. Keep
credentials out of evidence. Update this task's status in its own file; the
initiative plan owns overall status.
