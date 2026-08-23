---
id: T01
kind: task
status: complete
plan: ../plan.md
role: frontend
depends_on: []
parallel_with: []
write_scope:
  - front-end/src/FlowCanvas.svelte
  - front-end/src/utils.ts
  - front-end/src/styles/flowcanvas.css
  - front-end/src/__tests__/utils.test.ts
---

# Implement handle-overlap docking

## Objective

Turn a precise node-drop over an output handle into a normal logical Diagram
edge while keeping the node blocks as the only visible connection cue.

## Context required

  - `front-end/src/FlowCanvas.svelte`
  - `front-end/src/components/DockedGroup.svelte`
  - `front-end/src/core/DiagramCore.ts`
- `front-end/src/utils.ts`
- `front-end/src/core/DiagramCore.ts`
- `docs/knowledge/architecture/overview.md`
- `docs/knowledge/contracts/package-type-system.md`

## Invariants

- All graph mutation goes through DiagramCore validation and notifications.
- Coordinates only describe placement; edges remain the connectivity source.
- Existing subflow reparenting and ordinary handle connections remain valid.
- No dashboard mode or new graph state is introduced.

## Allowed files

- The files listed in `write_scope`.

## Out of scope

- Package definitions, type inference, conversion, training, and the saved VAE
  fixture.

## Work

1. Add a pure nearest-handle detector over screen-space rectangles.
2. Invoke it after the existing drag-stop/reparenting path and call
   `DiagramCore.addEdge()` for a valid pair.
3. Mark docking edges as presentation metadata and render their connected
   nodes with `DockedGroup.svelte`.
4. Hide only docked edge strokes without filtering DiagramCore edges.
5. Add unit coverage for the detector and metadata.

## Acceptance criteria

- [ ] Exact output/input overlap returns source, target, and handle IDs.
- [ ] Far-away or same-node handles do not connect.
- [ ] A join chooses its nearest target handle.
- [ ] Docked edges are visually grouped by a Svelte component that reads the
  canonical `Diagram`.
- [ ] Docking never creates a node and rejects non-layer handles.
- [ ] The frontend contains no NNC toolbar control or linear-layout mutation.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/utils.test.ts
pnpm --dir front-end check
```

## Required handoff

Return changed files, validation results, and any assumptions about the drop
tolerance or ordinary handle-drag behavior.
