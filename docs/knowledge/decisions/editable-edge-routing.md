# Editable edge routing

## Context

Connections need user-controlled orthogonal bends without changing their
computational meaning or violating the containment rules that govern subflows.

## Decision

Persist route metadata only at `edge.data.route.points`, as an array of finite
`{ x, y }` points. An empty array selects automatic routing. The route belongs
to the endpoints' shared immediate `parentId`: top-level points use the canvas
origin, while a subflow-internal edge stores points relative to that direct
subflow origin. The parent scope is derived from the endpoints and is never
duplicated in edge data.

All new and imported edges use the `editable` renderer. The canvas renderer
converts scope-local points to absolute geometry only while drawing and editing.
It commits a route change through `DiagramCore.updateEdgeRoute`; this gives one
immutable mutation, undo item, and graph-change notification per completed
gesture. Reconnecting either endpoint clears the manual route because its
geometry and immediate scope may no longer apply.

## Consequences

Route edits remain presentational metadata: they do not alter endpoints,
handles, containment validation, join ordering, or NNTree compilation. Legacy
edges without route metadata render automatically. PNG export keeps the final
route SVG path but filters pointer hit targets and selected editing controls.

## Status

Accepted.

## Links

- [Edge route core contract](../../../front-end/src/core/edgeRoute.ts)
- [Editable edge renderer](../../../front-end/src/edges/EditableEdge.svelte)
- [Editable-edge routing plan](../../plans/active/editable-edge-routing/plan.md)
