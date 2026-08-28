---
id: nnc-linear-graph
kind: plan
status: complete
updated: 2026-08-23
areas:
  - frontend
  - architecture
---

# NNC docked-node graph

## Goal

Make the editor behave like a block diagram: the user places a node, drags it
so its input handle is exactly over another node's output handle, and releases
to create a logical Diagram connection without rendering an edge stroke. The
blocks themselves remain visible and their spatial alignment communicates the
sequence.

## Current behavior

Svelte Flow owns the pointer gesture and emits a node-drag-stop event. Logical
connections are currently created by dragging from one handle to another and
are rendered as editable edges. `FlowCanvas.svelte` delegates containment
reparenting to `utils.ts`; `DiagramCore.addEdge()` validates and stores edges
for type inference and persistence.

## Scope

- Detect a precise output-handle/input-handle overlap when a node drag ends.
- Create the same validated `DiagramCore` edge used by ordinary handle
  connections.
- Render docked connected components with `DockedGroup.svelte`, an overlay
  that reads the canonical `Diagram` and draws a boundary around the actual
  Svelte Flow layer-node elements.
- Never create a node as part of docking; the gesture joins two existing layer
  nodes and only adds their logical edge.
- Keep node placement as the visual connection; do not add a dashboard mode or
  a new toolbar control.
- Keep logical edges in `DiagramCore`, snapshots, type inference, and saved
  diagrams while hiding only the rendered stroke for docked edges.
- Preserve ordinary Svelte Flow handle connections and existing subflow
  reparenting behavior.
- Add pure geometry tests and Browser verification using the saved VAE.

## Non-goals

- Do not create a second graph or encode connectivity in node coordinates.
- Do not remove edges from `DiagramCore` or change package/type inference.
- Do not add a presentation toggle, NNC dashboard button, or new stereotype.
- Do not replace the existing automatic layout algorithm.

## Decisions and invariants

- `DiagramCore.edges` is the sole logical authority. A docked visual
  connection always becomes a normal edge through `addEdge()`.
- Dock detection uses screen-space handle centers with a small tolerance so it
  is stable across canvas zoom. The target must be the node being dragged; the
  source must be a different node's source handle.
- The closest source/target pair wins. `DiagramCore` remains responsible for
  duplicate handles, cycles, scope boundaries, and all other validation.
- `Diagram.isLayerNode()` is the presentation invariant: only layer handles
  participate in docking and only layer nodes can enter `DockedGroup`.
- Ordinary edge rendering and the handle connection gesture remain available.
  Only edges marked as docked omit their renderer; their `DiagramCore` state is
  unchanged.
- `DockedGroup.svelte` receives the `Diagram` instance rather than a second
  nodes/edges state; it measures DOM geometry only to paint the group shell.

## Contracts and control flow

```text
node drag stop
  -> existing subflow reparenting
  -> read final DOM handle rectangles
  -> nearest source/target overlap?
       no  -> finish normal drag
       yes -> DiagramCore.addEdge(source, target, handles)
  -> type refresh; edge remains stored but not painted
  -> DockedGroup observes the docked edge and frames the connected nodes
```

The dock detector is pure (`findDockedConnection`) and receives measured
rectangles, so it can be tested without a Browser or a second graph model.

## Task graph

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [`T01`](tasks/T01-dock-gesture.md) | frontend | — | — | `front-end/src/FlowCanvas.svelte`, `front-end/src/components/DockedGroup.svelte`, `front-end/src/core/DiagramCore.ts`, `front-end/src/utils.ts`, `front-end/src/styles/flowcanvas.css`, tests | Handle-overlap docking creates a logical edge and visual group |
| [`T02`](tasks/T02-browser-verification.md) | integration | T01 | — | `docs/plans/active/nnc-linear-graph/evidence/` | Browser evidence for visible docking and hidden strokes |

## Integration and review gates

- Geometry tests cover precise overlap, tolerance rejection, nearest join
  handle, and source/target filtering.
- Frontend type-check and unit tests pass.
- Browser verification shows the dropped node visually attached to the source
  output, a `DockedGroup` boundary, no painted edge stroke, the extra logical
  edge after docking, and valid type inference.
- Normal handle-to-handle connections and subflow reparenting still work.
- Review blocks completion if the implementation stores connectivity only in
  coordinates or introduces a dashboard control for this behavior.

## Acceptance criteria

- [ ] Dropping a node's input handle on another node's output handle creates a
  valid Diagram edge.
- [ ] The graph remains visually block-based with no rendered edge strokes.
- [ ] The edge remains in saved/exported Diagram state and type inference.
- [ ] No NNC toolbar button or alternate graph/presentation mode exists.
- [ ] Existing editor behavior outside docking remains intact.

## Final verification

Run from the repository root unless noted otherwise:

```bash
pnpm --dir front-end check
pnpm --dir front-end test -- --run src/__tests__/utils.test.ts
pnpm --dir front-end test -- --run src/__tests__/packageEditorModels.test.ts
pnpm --dir front-end guard:package-only
git diff --check
```

Then exercise the gesture in the Codex in-app Browser with
`examples/diagrams/package/variational-autoencoder-complete.json`.

## Knowledge and archive impact

- The current architecture contract remains that DiagramCore owns live graph
  state; this plan adds only a user gesture at the frontend boundary.
- If edge visibility or docking tolerance becomes a persisted user preference,
  record that separately under `docs/knowledge/contracts/`.
