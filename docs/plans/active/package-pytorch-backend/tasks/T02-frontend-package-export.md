---
id: T02
kind: task
status: superseded
plan: ../plan.md
superseded_by: ../../package-backend-standard/tasks/P06-frontend-api.md
role: frontend
depends_on: [T01]
parallel_with: [T03]
write_scope:
  - front-end/src/type-system/
  - front-end/src/training/package-bundle.ts
  - front-end/src/__tests__/
---

# Export the browser package closure

## Objective

Export a deterministic, validated package bundle from the active browser
catalog, including the exact `pytorch.py` resources required by the current
semantic graph, without moving Python execution or graph ownership into the
browser.

## Context required

- [Initiative plan](../plan.md)
- Accepted T01 bundle contract.
- `front-end/src/type-system/bundled/catalog.ts`
- `front-end/src/type-system/host.ts`
- `front-end/src/type-system/packages/catalog.ts`
- `front-end/src/type-system/packages/types.ts`
- `front-end/src/core/DiagramCore.ts`
- `front-end/src/Diagram.svelte.ts`

## Invariants

- Use the existing Cordis-owned package activation/catalog lifecycle. New
  resource leases, upload cancellation and cleanup must be disposal-aware.
- Export exact IDs/versions and dependency closure; never resolve by display
  name or package-ID-specific compiler switch.
- Exclude layout-only fields from semantic compilation but preserve containment,
  parameters, edges and `targetHandle` order.
- Never invoke `pytorch.py` or Python from the frontend.

## Allowed files

- Package catalog/types/host/export modules under `front-end/src/type-system/`.
- The dedicated transport model under `front-end/src/training/package-bundle.ts`.
- Focused frontend package and training API tests under `front-end/src/__tests__/`.

## Out of scope

- Backend validation, Python module execution and container command creation.
- Changes to the live graph authority or MCP-owned graph state.

## Work

1. Extend the resource seam so a package can read its declared PyTorch file and
   required metadata without exposing arbitrary filesystem reads.
2. Build a canonical bundle exporter with stable ordering, byte limits and
   SHA-256 digest input defined by T01.
3. Validate the selected graph and dependency closure before upload; report
   missing PyTorch entrypoints as an actionable user-facing error.
4. Add tests for exact package identity, nested subflows, ordered joins,
   missing resources, deterministic bytes and disposal/cancellation.

## Acceptance criteria

- [ ] A valid package graph produces the agreed bundle shape and digest.
- [ ] `pytorch.py` is included when declared and absent packages fail before
      network submission.
- [ ] The exporter observes the current Cordis lifecycle and leaves no active
      resource after disposal.
- [ ] Existing package inference and package-only guards remain green.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/packageTypeGraph.test.ts
pnpm --dir front-end check
pnpm --dir front-end guard:package-only
```

## Required handoff

Return bundle examples, digest rules, changed files, test results and any
frontend assumptions that T04 must enforce server-side.
