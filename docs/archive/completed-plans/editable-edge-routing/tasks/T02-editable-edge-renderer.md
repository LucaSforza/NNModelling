---
id: T02
kind: task
status: done
plan: ../plan.md
role: frontend
depends_on:
  - T01
parallel_with: []
write_scope:
  - front-end/src/edges/
  - front-end/src/styles/editable-edge.css
---

# Render and edit orthogonal edge routes

## Objective

Create a custom Svelte Flow edge component that renders automatic and
manual orthogonal routes and provides accessible, pointer-safe selected-edge
controls that commit through the `DiagramCore` route API only after a completed
interaction.

## Context required

- [`../plan.md`](../plan.md) and `T01-edge-route-state.md`.
- `front-end/src/Diagram.svelte.ts`: Diagram context and reactive arrays.
- `front-end/src/nodes/CustomNode.svelte`: project conventions for Svelte 5
  reactivity and directional handles.
- Svelte Flow `EdgeProps`, `BaseEdge`, `useSvelteFlow`, and edge-selection
  semantics.

## Invariants

- The path generator is a pure function of endpoint positions, direction, and
  normalized scope-local route points; it neither reads nor writes Diagram
  state.
- Use `screenToFlowPosition` for pointer conversion and convert scope-local
  points with the current containing subflow origin. Do not persist a viewport
  transform or absolute subflow position.
- Pointer moves update local preview only. Pointer capture, Escape, and
  `pointercancel` reliably end an interaction without leaking preview state.
- Interactive controls prevent unintended canvas pan/drag and are visible only
  for the selected edge. The edge path retains a generous hit target.
- Rendering an absent, empty, malformed, or legacy route is safe and falls back
  to automatic geometry.

## Allowed files

- `front-end/src/edges/` for the new component, pure route-path helper, and
  unit tests.
- `front-end/src/styles/editable-edge.css` for selected route and control
  styling.

## Out of scope

- Editing DiagramCore, import/export normalization, FlowCanvas registration,
  or PNG filtering.
- Endpoint reconnection controls and obstacle avoidance.
- Changes to node components, handle positions, or layout algorithms.

## Work

1. Implement and unit-test a pure orthogonal path generator with automatic
   fallback and deterministic points-to-SVG conversion.
2. Implement `EditableEdge.svelte` using the component's typed edge props,
   `BaseEdge`, Diagram context, and the core route API.
3. On a selected route, allow drag-to-create or drag-to-move a bend, remove a
   selected bend, reset the route, and cancel an unfinished gesture.
4. Keep previews local until the gesture finishes, then make exactly one core
   call.
5. Run the targeted checks below.

## Acceptance criteria

- [ ] Automatic routes and routes with zero, one, and multiple bend points
  render deterministically as orthogonal paths.
- [ ] A selected edge can be reshaped with pointer input without panning the
  canvas or producing a mutation for each pointer move.
- [ ] Cancelled interactions leave the persisted edge untouched; committed
  ones use the T01 core operation exactly once.
- [ ] No changes outside `write_scope`.

## Validation

Run from the repository root:

```bash
pnpm --dir front-end test -- src/edges/routePath.test.ts
pnpm --dir front-end check
```

## Required handoff

Return:

- files changed and a concise explanation of each change;
- exact commands run and their results;
- decisions or assumptions made within the task contract;
- unresolved risks, blockers, or follow-up work;
- any current-knowledge document that would become inaccurate.
