---
id: T04
kind: task
status: done
plan: ../plan.md
role: frontend
depends_on:
  - T03
parallel_with: []
write_scope:
  - front-end/src/FlowCanvas.svelte
  - front-end/src/nodes/CustomNode.svelte
  - front-end/src/nodes/JoinNode.svelte
  - front-end/src/nodes/SubflowNode.svelte
  - front-end/src/styles/flowcanvas.css
  - front-end/src/styles/node.css
  - front-end/src/styles/join.css
  - front-end/src/styles/subflow.css
  - docs2/source/user_guide.rst
  - docs/knowledge/architecture/overview.md
  - docs/plans/active/automatic-layout/evidence/visual-verification.md
---

# Add the layout menu, directional handles and visual verification

## Objective

Let users run either automatic layout from the toolbar and see correctly
oriented handles, subflows and viewport framing in all required visual cases.

## Context required

- [Automatic compound layout](../plan.md)
- `DiagramCore.autoLayout()` and persisted direction from T03
- Svelte Flow's [handle guidance](https://svelteflow.dev/learn/customization/handles)
- Svelte Flow's
  [`useUpdateNodeInternals`](https://svelteflow.dev/api-reference/hooks/use-update-node-internals)
- Existing toolbar and `fitView()` integration in `FlowCanvas.svelte`

## Invariants

- The user action invokes the core mutation; components do not calculate graph
  geometry.
- Handle IDs remain `in`, `out`, `in-0`, `in-1`, ... in both directions.
- Direction is read from diagram context rather than copied into every node.
- Svelte 5 event syntax and rune patterns remain current.
- External Svelte Flow internals are refreshed only after the DOM reflects the
  new direction; state is never mutated from that synchronization effect.

## Allowed files

- Only the UI, style, user documentation, architecture note and initiative
  evidence files listed in `write_scope`.

## Out of scope

- Edge type or routing changes.
- Layout settings beyond the two direction actions.
- Persistent menu-open state, pinned nodes or selection-only layout.

## Work

1. Add an accessible toolbar button/menu with `Verticale` and `Orizzontale`
   actions and a concise non-destructive error display for rejected layout.
2. After an accepted layout, wait for Svelte rendering, refresh all affected
   node internals, then call `fitView({ maxZoom: 1, padding: 0.2 })`.
3. Synchronize node internals when direction changes through import, undo or
   redo as well as the direct menu action.
4. Render target/source handles top/bottom vertically and left/right
   horizontally. Rotate the join's visual axis and distribute ordered target
   handles left-to-right or top-to-bottom.
5. Update the user guide and current architecture summary.
6. Run automated gates, then execute and record the live-browser acceptance
   matrix using repository example diagrams.

## Acceptance criteria

- [x] One toolbar control clearly exposes both layout directions.
- [x] The vertical action produces top/bottom handles and the horizontal action
      produces left/right handles on custom, join and subflow nodes.
- [x] Join inputs display in semantic ID order in both orientations.
- [x] Edges attach to the new handle positions without stale endpoints.
- [x] `fitView()` runs after layout rendering and frames the complete graph.
- [x] Undo/redo and save/load orientation changes also refresh handle internals.
- [x] The skip/repeat example passes vertical, horizontal, collapsed and
      re-expanded checks.
- [x] The nested-autoencoder example keeps every descendant within the correct
      recursive parent.
- [x] User documentation explains the menu, full-graph behavior and undo.
- [x] The evidence file records tested examples, directions and observed result
      without volatile test-count claims.
- [x] No UI-task changes occur outside `write_scope`.

## Validation

Run from the repository root:

```bash
pnpm --dir front-end check
pnpm --dir front-end test
NNM_DIAGRAM=skip_connections_with_repetition pnpm --dir front-end test:integration:smoke
NNM_DIAGRAM=auto_encoder_submodels_with_submodels pnpm --dir front-end test:integration:smoke
pnpm run docs
```

Live-browser acceptance matrix:

1. Load `skip_connections_with_repetition`; run vertical then horizontal.
2. Verify skip branches, join handle order and subflow bounds.
3. Collapse the Repeat subflow, rerun layout, expand it and verify its hidden
   children remained arranged.
4. Undo and redo once; verify positions, dimensions and handles together.
5. Save horizontally, reload and verify left/right handles.
6. Load `auto_encoder_submodels_with_submodels`; run both directions and inspect
   every nesting level for containment and overlap.

## Required handoff

Return:

- files changed and a concise explanation of each change;
- exact commands run and their results;
- the completed visual acceptance matrix and evidence path;
- any browser-specific rendering difference;
- unresolved risks, blockers or follow-up work.
