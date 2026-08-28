---
id: T01
kind: task
status: done
plan: ../plan.md
role: architecture
depends_on: []
parallel_with: []
write_scope:
  - front-end/src/core/
  - front-end/src/__tests__/edgeRoute.test.ts
  - front-end/src/__tests__/graphChange.test.ts
---

# Define persistent edge-route state

## Objective

Give `DiagramCore` one validated, immutable operation for setting or clearing
the route points of an existing edge, with import, new-edge, reconnect, and
duplicate behavior that preserves the plan's route contract.

## Context required

- [`../plan.md`](../plan.md), especially its data contract and invariants.
- `front-end/src/core/DiagramCore.ts`: edge creation, reconnection,
  duplication, snapshots, and serialization.
- `front-end/src/core/containment.ts`: immediate-scope ownership.
- `front-end/src/__tests__/graphChange.test.ts`: one-notification and no-op
  graph-mutation contract.

## Invariants

- `edge.data.route.points` contains only finite coordinates and an empty list
  means automatic routing.
- A route operation cannot create, delete, reconnect, or otherwise alter an
  edge's semantic endpoints or handles.
- Accepted route changes capture one snapshot, replace the affected edge and
  its data immutably, then notify once. Unknown edges, equal routes, and
  rejected malformed routes do not capture or notify.
- Importing a legacy edge without a type or route remains valid; new and
  normalized edges use `type: "editable"`.
- Reconnecting clears manual points. Duplicating an internal edge copies its
  route data without aliasing the source edge's route array.

## Allowed files

- `front-end/src/core/` for the narrow type, validation, and DiagramCore
  changes.
- `front-end/src/__tests__/edgeRoute.test.ts` for route-state regressions.
- `front-end/src/__tests__/graphChange.test.ts` for notification and undo
  behavior.

## Out of scope

- Rendering SVG paths, pointer handling, canvas registration, or PNG export.
- Adding an RPC mutation for edge-route editing.
- Changing containment or connection-validation rules.

## Work

1. Add a small core-owned route type and pure normalization/equality helpers.
2. Add an atomic public `DiagramCore` route-update operation and a clear-route
   form if that keeps callers simpler.
3. Normalize imported/new edge type metadata, clear routes on reconnect, and
   deep-copy route data when duplicating an edge.
4. Add regression coverage for finite validation, no-op behavior, one undo
   item, import/export compatibility, reconnect reset, and duplicate isolation.
5. Run the targeted checks below.

## Acceptance criteria

- [ ] The core exposes one documented route-data contract and atomic mutation
  path.
- [ ] Old JSON without the new fields imports successfully and gains an
  editable runtime edge type without changing endpoints or handles.
- [ ] Route data survives snapshots and export/import; reconnect clears it and
  duplicate edges receive independent copies.
- [ ] No changes outside `write_scope`.

## Validation

Run from the repository root:

```bash
pnpm --dir front-end test -- src/__tests__/edgeRoute.test.ts src/__tests__/graphChange.test.ts
pnpm --dir front-end check
```

## Required handoff

Return:

- files changed and a concise explanation of each change;
- exact commands run and their results;
- decisions or assumptions made within the task contract;
- unresolved risks, blockers, or follow-up work;
- any current-knowledge document that would become inaccurate.
