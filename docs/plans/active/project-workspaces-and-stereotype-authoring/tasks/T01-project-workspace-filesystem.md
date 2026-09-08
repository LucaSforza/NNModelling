---
id: T01
kind: task
status: ready
plan: ../plan.md
role: frontend
depends_on: []
parallel_with: [T03]
write_scope:
  - front-end/src/project-workspace/
  - front-end/src/__tests__/projectWorkspace.test.ts
---

# Add the writable project filesystem boundary

## Objective

Provide one testable browser adapter that creates a project child under a
selected parent, opens an existing project directory, reads its model resources
and performs ordered scoped writes without leaking filesystem handles into
domain state.

## Context required

- [Plan](../plan.md)
- [Project workspace decision](../../../../knowledge/decisions/project-workspaces-and-stereotype-authoring.md)
- `front-end/src/utils.ts` current bundle-directory reader
- `front-end/src/core/types.ts` model manifest validator

## Invariants

- The selected handle is session-only capability state.
- A new child named by model ID is never merged with or written over an
  existing entry.
- Paths are normalized, relative and confined to the selected project.
- Ordered writes cannot let an older save replace a newer graph state.
- Removal is available only for a child proven to have been created by the
  current operation.

## Allowed files

- `front-end/src/project-workspace/`
- `front-end/src/__tests__/projectWorkspace.test.ts`

## Out of scope

- Svelte UI, Diagram construction, package activation, recent-project history,
  persisted handles, datasets and ZIP export.

## Work

1. Define minimal structural TypeScript interfaces around the File System
   Access API so tests can use in-memory handles.
2. Implement parent selection, exact child creation, existing-project
   selection, permission checks, recursive resource reads and confined file
   writes.
3. Add a one-writer queue that coalesces or serializes model saves while
   preserving the newest accepted state and exposes pending/success/failure.
4. Define scoped creation rollback that refuses to remove any pre-existing
   directory.
5. Characterize cancellation, unsupported browser, denied permission,
   collision, malformed paths, delayed writes and write failures.

## Acceptance criteria

- [ ] New and open return the same project resource shape expected by model
      scope preparation.
- [ ] Existing children and escaping paths are rejected before writes.
- [ ] Delayed writes finish in graph-version order and report failures.
- [ ] Handles do not appear in serialized project data.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/projectWorkspace.test.ts
pnpm --dir front-end check
```

## Required handoff

Report the workspace API, browser capability assumptions, rollback proof,
changed files, exact test results and any integration requirement for T02/T05.
