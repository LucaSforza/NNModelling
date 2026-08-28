---
id: editable-edge-routing
kind: plan
status: done
updated: 2026-08-16
areas:
  - frontend
  - interaction
  - serialization
---

# Editable UML-style edge routing

> Implementation completed. This plan is retained as historical delivery
> context; the current invariant is recorded in
> `docs/knowledge/decisions/editable-edge-routing.md`.

## Goal

Let a user reshape a connection directly on the canvas, in the familiar style
of UML class-diagram associations. An edge remains a semantic connection between
the same handles, but can have persistent, orthogonal bend points that the user
adds, moves, removes, and resets without changing the model's computation.

## Current behavior

`FlowCanvas.svelte` binds the diagram's plain Svelte Flow edges directly and
registers custom node types only. Edges therefore use Svelte Flow's built-in
default rendering and have no editable route geometry. `DiagramCore` owns edge
creation, reconnection, snapshots, import/export, and graph-change
notifications; diagram JSON already persists arbitrary edge fields. The
containment contract requires both endpoints of every edge to belong to the
same immediate scope.

## Scope

- Render all newly created and imported edges with an editable custom edge.
- Use orthogonal, UML-like polylines: an empty route is automatically drawn;
  manually placed bend points override that automatic route.
- Allow direct mouse or touch dragging of a segment to create or move a bend,
  visible point handles on a selected edge, removal of a selected bend, and a
  reset action that returns the edge to automatic routing.
- Persist route points in the edge's `data` field; preserve them across
  save/load, undo/redo, copy/duplicate, and the browser graph API.
- Keep route points in the coordinate system of the edge's immediate
  containment scope so moving a subflow moves its internal edge routes with it.
- Exclude editing controls, but not the resulting route, from PNG export.

## Non-goals

- Automatic obstacle avoidance, global edge-routing optimization, or bundled
  routing libraries.
- Connections to the middle of an edge, semantic changes to source/target
  handles, or changes to tensor inference and NNTree compilation.
- Editing a route through an MCP-specific command. The existing graph read API
  exposes the persisted edge data; interactive editing remains a canvas action.
- Automatic conversion of an existing hand-routed edge when automatic layout
  moves nodes. User-authored routes remain user-authored until reset.

## Decisions and invariants

- The canonical persisted shape is `edge.data.route.points`, an array of
  finite `{ x, y }` positions. It stores no SVG path, viewport transform, or
  derived absolute coordinate.
- The owning scope is derived from the two endpoints' shared immediate
  `parentId`, never duplicated in edge data. Top-level edges use the canvas
  origin; subflow-internal routes use their direct subflow origin.
- Route edits are presentational metadata. They must not relax connection
  validation, cross a containment boundary, alter ordered join handles, or
  affect compilation.
- A drag is preview-only until pointer release. One accepted release performs
  one immutable `DiagramCore` mutation, one undo capture, and one graph-change
  notification. Escape or pointer cancellation discards the preview.
- Reconnecting either endpoint clears the manual route because the old points
  belong to different endpoint geometry and may belong to a different scope.
- New edges and legacy imported edges use `type: "editable"`. A legacy edge
  with no route remains visually automatic and semantically unchanged.
- Duplicate edges preserve their route metadata. The PNG contains paths only;
  selected-state grips and other editing affordances are excluded.

## Contracts and control flow

```text
pointer drag on editable edge
        |
        v
local route preview (flow coordinates, no DiagramCore mutation)
        |
        +-- cancel --> discard preview
        |
        +-- pointer release --> DiagramCore.updateEdgeRoute(edgeId, points)
                                  |
                                  v
                          snapshot + immutable edge replacement
                                  |
                                  v
                  Svelte reactivity, export/import, undo/redo, PNG path
```

The renderer converts client coordinates with `screenToFlowPosition`, then
converts between scope-local stored points and absolute edge coordinates using
the containing subflow's current absolute position. Its path generator receives
only source/target handle positions plus normalized points and must be pure.

## Task graph

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [T01](tasks/T01-edge-route-state.md) | `architecture` | — | — | `front-end/src/core/`, `front-end/src/__tests__/edgeRoute.test.ts`, `front-end/src/__tests__/graphChange.test.ts` | Persistent route contract and atomic DiagramCore mutation. |
| [T02](tasks/T02-editable-edge-renderer.md) | `frontend` | `T01` | — | `front-end/src/edges/`, `front-end/src/styles/editable-edge.css` | Pure orthogonal renderer and interactive selected-edge controls. |
| [T03](tasks/T03-canvas-integration.md) | `integration` | `T01`, `T02` | — | `front-end/src/FlowCanvas.svelte`, `front-end/src/pngExport.ts`, `front-end/src/__tests__/pngExport.test.ts`, `docs/knowledge/decisions/editable-edge-routing.md` | Editor registration, PNG behavior, and durable ownership record. |

## Integration and review gates

- Inspect the combined diff for direct mutation of `edge.data`, per-pointer-move
  undo snapshots, duplicate custom-edge registration, and changes to edge
  endpoint validation.
- Verify a top-level edge and an edge inside a nested subflow. Move the
  containing subflow after routing its internal edge; its bends must travel
  with it.
- Load a pre-feature diagram with edges lacking `type` and `data.route`; it
  must render, compile, and save successfully.
- Reconnect an edge, undo/redo the operation, duplicate its endpoints, and
  export a PNG. The route reset/preservation behavior must match the decisions
  above, and grips must never be present in the PNG.

## Acceptance criteria

- [ ] A selected edge exposes usable mouse and touch controls for creating,
  moving, removing, and resetting orthogonal bends.
- [ ] A completed drag records exactly one undoable graph mutation; cancelling
  it records none.
- [ ] Route geometry survives save/load, undo/redo, duplication, and browser
  graph inspection without changing connection or compilation semantics.
- [ ] Scope-local routes remain aligned when a containing subflow moves, while
  invalid cross-scope connections remain rejected.
- [ ] Existing diagrams without route metadata remain compatible.
- [ ] PNG export contains the routed edges but no selection grips or controls.

## Final verification

Run from the repository root unless noted otherwise:

```bash
pnpm --dir front-end test -- src/__tests__/edgeRoute.test.ts src/__tests__/graphChange.test.ts src/edges/routePath.test.ts src/__tests__/pngExport.test.ts
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end test:integration:smoke
```

In the live editor, load a diagram with a nested subflow and verify the
integration and review gates using pointer interaction at more than one zoom
level. Repeat after saving and reloading the diagram.

## Knowledge and archive impact

- Create `docs/knowledge/decisions/editable-edge-routing.md` when the feature
  lands. It must record the edge-data contract, scope-local coordinate rule,
  and endpoint-reconnection reset rule.
- Preserve only useful manual-verification evidence with this initiative when
  it is completed, then mark the plan `done` and move it intact to
  `docs/archive/completed-plans/`.
