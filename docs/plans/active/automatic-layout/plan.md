---
id: automatic-compound-layout
kind: plan
status: ready
updated: 2026-08-13
areas:
  - frontend
  - visual-editor
  - graph-layout
---

# Automatic compound layout

## Goal

Add one toolbar control that arranges the complete neural-network diagram in a
vertical or horizontal direction. The result must remain readable for branches,
joins and skip connections, recursively place every child inside its subflow,
resize subflows around their contents, preserve collapsed children for later
expansion, and behave as one undoable graph operation.

## Current behavior

- New nodes spawn near the viewport center with a random offset and must be
  positioned manually in `front-end/src/FlowCanvas.svelte`.
- `front-end/src/utils.ts` reparents nodes on drag and stores child positions
  relative to their `parentId`.
- `CustomNode.svelte`, `JoinNode.svelte` and `SubflowNode.svelte` use top input
  handles and bottom output handles unconditionally.
- `DiagramCore.moveNodes()` can update positions atomically, but no mutation
  currently updates positions, subflow dimensions and presentation direction
  together.
- Collapse hides descendants and records expanded dimensions in `oldWidth` and
  `oldHeight`; hidden children continue to compile.

The browser `DiagramCore` remains the authority described by
[Browser-backed MCP](../../../knowledge/architecture/browser-mcp.md).

## Scope

- A toolbar button with a menu containing `Verticale` and `Orizzontale`.
- Recursive bottom-up layout with `@dagrejs/dagre` for every containment scope.
- Automatic growth and shrinkage of expanded subflows around their contents.
- Layout of hidden children even while an ancestor is collapsed.
- Dynamic top/bottom or left/right handles for all node types.
- Persistent, backward-compatible layout direction metadata.
- One undo snapshot and one synchronous graph-change notification per accepted
  layout operation, followed by a correctly timed `fitView()`.
- Enforcement of the subflow boundary rule on connection, reconnection,
  reparenting and import paths.

## Non-goals

- Automatic edge routing or changing the current Svelte Flow edge type.
- Pinned nodes, partial-selection layout or layout of only one subflow.
- Continuous layout while dragging, adding or editing nodes.
- Animated node transitions.
- User-configurable spacing, padding or rank settings in this iteration.
- Replacing Dagre with ELK.

## Decisions and invariants

- Follow [Use recursive Dagre layout](../../../knowledge/decisions/recursive-compound-layout.md).
- Vertical is the default direction for old diagrams and the primary DSL
  direction. Horizontal is an explicit menu action.
- An edge is legal only when `source.parentId ?? null` equals
  `target.parentId ?? null`. A subflow participates as an ordinary atomic node
  in its parent's scope; its children never connect directly outside it.
- Layout is bottom-up: recursively lay out direct children, compute each
  expanded subflow size, then lay out the parent scope.
- Direct child coordinates stay relative to their parent. Top-level coordinates
  remain absolute flow coordinates.
- Parents precede descendants in the resulting node array, as required by
  Svelte Flow subflows.
- A collapsed subflow's children are still repositioned. Its computed expanded
  dimensions are saved in `data.oldWidth` and `data.oldHeight`, while its
  visible collapsed dimensions remain compact for the outer layout.
- Layout may change only positions, expanded subflow dimensions, layout
  direction and the parent-before-child array order. It must preserve IDs,
  stereotypes, parameters, containment, edge endpoints/handles, hidden state
  and tensor semantics.
- Join target handles retain their semantic IDs. In vertical mode `in-0`,
  `in-1`, ... appear left-to-right; in horizontal mode they appear
  top-to-bottom. The output is bottom or right respectively.
- Layout computation and validation finish before undo capture. Invalid input
  must leave graph state and history unchanged.
- Reapplying an identical layout is a no-op: no undo entry and no graph-change
  notification.

## Contracts and control flow

```text
Toolbar menu action
  -> DiagramCore.autoLayout(direction)
       -> validate containment and edge scopes
       -> computeAutoLayout(nodes, edges, direction)
            -> recursively layout deepest child scope
            -> resize its parent subflow
            -> layout the next outer scope
            -> layout the top-level scope
       -> capture one undo snapshot
       -> replace the node array and layout direction
       -> notify graph change once
  -> wait for Svelte DOM update
  -> updateNodeInternals(all node IDs) when handles changed
  -> fitView({ maxZoom: 1, padding: 0.2 })
```

The pure layout result owns no graph state. `DiagramCore` applies the result;
the Svelte wrapper only exposes reactive fields, and `FlowCanvas.svelte` owns
the browser-only node-internals and viewport synchronization.

### Layout geometry

- Dagre receives only the direct children and direct edges of one scope.
- A node's layout size is resolved from measured dimensions, then explicit
  dimensions, then a type-specific fallback for unmeasured nodes such as joins.
- Node centers returned by Dagre are converted to Svelte Flow top-left
  positions and normalized to non-negative content coordinates.
- Expanded subflow bounds include fixed side/bottom padding plus an upper inset
  for the header and visible top parameters. Bottom parameters contribute to
  the lower inset. These constants live beside the layout engine and are not UI
  settings in this iteration.
- Disconnected components and orphan nodes are included in the same Dagre scope
  and must not overlap.
- Coordinates are rounded consistently so repeated layout calls are stable.

### Persistence compatibility

Editable diagram JSON gains an optional top-level `layoutDirection` value of
`"vertical"` or `"horizontal"`. Import defaults missing or unknown values to
`"vertical"`. Snapshots include the same field so undo/redo restores both node
geometry and handle orientation. NNTree output does not change.

## Task graph

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [T01](tasks/T01-containment-boundaries.md) | `frontend` | — | — | frontend containment, validation and tests | All editor mutation paths preserve subflow edge boundaries. |
| [T02](tasks/T02-recursive-layout-engine.md) | `frontend` | `T01` | — | layout module, dependency manifest and focused tests | A pure function computes deterministic recursive TB/LR geometry. |
| [T03](tasks/T03-atomic-layout-state.md) | `frontend` | `T02` | — | diagram state, snapshots, serialization and tests | Layout applies atomically and direction round-trips compatibly. |
| [T04](tasks/T04-layout-ui-and-verification.md) | `frontend` | `T03` | — | canvas, node components/styles, user docs and evidence | Users can choose either layout and obtain correct handles and viewport. |

Tasks are sequential because later contracts consume earlier ones and T01/T03
both touch `DiagramCore`.

## Integration and review gates

- Review must reject any second source of diagram state outside `DiagramCore`.
- Review must reject per-node duplicated direction metadata or mutation through
  a Svelte `$effect`; layout is triggered by the menu event.
- The only reactive effect permitted for this feature is synchronization with
  Svelte Flow's external node-internals cache when persisted direction changes
  through layout, import, undo or redo.
- Existing diagram files load vertically when direction metadata is absent.
- Existing editable examples, including nested and collapsed subflows, retain
  identical compilation semantics before and after layout.
- The final visual check must cover both directions, a skip join, an expanded
  Repeat subflow, the same subflow collapsed and at least one nested subflow.
- No edge endpoint, handle ID, parent ID, stereotype parameter or hidden flag
  changes during automatic layout.

## Acceptance criteria

- [ ] The toolbar exposes one layout menu with vertical and horizontal actions.
- [ ] Vertical layout orders flow from top to bottom with inputs above losses.
- [ ] Horizontal layout orders flow left to right and moves handles to the
      corresponding sides.
- [ ] Every nested child lies within its expanded parent bounds with header and
      parameter clearance.
- [ ] Expanded subflows grow or shrink to the calculated content bounds.
- [ ] Collapsed descendants are laid out and display correctly after expansion.
- [ ] Join input handle ordering follows the chosen visual convention without
      changing semantic handle IDs.
- [ ] One layout is one undoable mutation; undo/redo restores direction,
      dimensions and positions together.
- [ ] Save/load preserves horizontal direction; old files default vertically.
- [ ] Direct child-to-outside edges cannot be created, reconnected, introduced
      by reparenting or loaded from a file.
- [ ] Repeating the same layout is stable and creates no overlaps or extra undo
      entries.
- [ ] NNTree JSON produced before and after layout is semantically identical.

## Final verification

Run from the repository root:

```bash
pnpm --dir front-end check
pnpm --dir front-end test
NNM_DIAGRAM=skip_connections_with_repetition pnpm --dir front-end test:integration:smoke
NNM_DIAGRAM=auto_encoder_submodels_with_submodels pnpm --dir front-end test:integration:smoke
pnpm run docs
```

Perform the visual acceptance matrix from T04 in a live browser after the
automated gates pass.

## Knowledge and archive impact

- The architectural choice is recorded in
  `docs/knowledge/decisions/recursive-compound-layout.md`.
- When implementation lands, update `docs/knowledge/architecture/overview.md`
  with the persisted presentation metadata and containment-boundary invariant.
- Retain only the visual acceptance summary under this initiative's `evidence/`.
- When all gates pass, mark the plan and tasks `done` and move the initiative
  intact to `docs/archive/completed-plans/automatic-layout/`.
