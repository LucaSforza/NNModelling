---
id: T03
kind: task
status: done
plan: ../plan.md
role: integration
depends_on:
  - T01
  - T02
parallel_with: []
write_scope:
  - front-end/src/FlowCanvas.svelte
  - front-end/src/pngExport.ts
  - front-end/src/__tests__/pngExport.test.ts
  - docs/knowledge/decisions/editable-edge-routing.md
---

# Integrate editable edges with the canvas and export

## Objective

Register the editable edge as the consistent canvas edge type, keep its
controls out of PNG output, and record the durable route-ownership decision for
future work.

## Context required

- [`../plan.md`](../plan.md), `T01-edge-route-state.md`, and
  `T02-editable-edge-renderer.md`.
- `front-end/src/FlowCanvas.svelte`: Svelte Flow bindings, default edge
  options, graph-change synchronization, and PNG export flow.
- `front-end/src/pngExport.ts`: DOM element filtering contract.
- `docs/knowledge/decisions/README.md`: current-decision document format.

## Invariants

- `edgeTypes` has stable identity and maps the persisted `"editable"` type to
  the custom component.
- User-created edges and legacy imported edges both render through the same
  component; no duplicate rendering or fallback warning is introduced.
- The final SVG path remains included by PNG export. Only temporary selection
  grips, route controls, and other interactive elements are filtered out.
- Existing graph-change synchronization, node layout behavior, and default
  arrow markers remain unchanged.

## Allowed files

- `front-end/src/FlowCanvas.svelte` for component registration and default
  options.
- `front-end/src/pngExport.ts` and `front-end/src/__tests__/pngExport.test.ts`
  for export filtering and regressions.
- `docs/knowledge/decisions/editable-edge-routing.md` for the durable
  architecture decision described in the plan.

## Out of scope

- Changes to DiagramCore or the custom-edge implementation.
- Broad PNG-export redesign, changes to node rendering, or public-documentation
  restructuring.

## Work

1. Register the renderer through a stable `edgeTypes` mapping and set the
   consistent default for newly created canvas edges.
2. Mark temporary controls so the PNG filter excludes them while retaining the
   routed SVG path.
3. Add focused export-filter regression coverage.
4. Record the final edge-data, scope-coordinate, and reconnect-reset decisions
   in current knowledge.
5. Run the targeted checks below, then perform the manual verification named in
   the plan.

## Acceptance criteria

- [ ] The canvas renders editable custom edges for both new and legacy diagrams.
- [ ] PNG export shows each edited path and never shows manipulation controls.
- [ ] The knowledge record gives future agents the authoritative route contract
  without relying on this plan's implementation history.
- [ ] No changes outside `write_scope`.

## Validation

Run from the repository root:

```bash
pnpm --dir front-end test -- src/__tests__/pngExport.test.ts
pnpm --dir front-end check
pnpm --dir front-end test:integration:smoke
```

## Required handoff

Return:

- files changed and a concise explanation of each change;
- exact commands run and their results;
- decisions or assumptions made within the task contract;
- unresolved risks, blockers, or follow-up work;
- any current-knowledge document that would become inaccurate.
