---
id: T02
kind: task
status: ready
plan: ../plan.md
role: frontend
depends_on:
  - T01
parallel_with: []
write_scope:
  - front-end/package.json
  - pnpm-lock.yaml
  - front-end/src/layout/
  - front-end/src/__tests__/layout.test.ts
---

# Build the recursive layout engine

## Objective

Provide a pure, deterministic function that returns complete vertical or
horizontal geometry for a valid recursively nested diagram.

## Context required

- [Automatic compound layout](../plan.md)
- [Recursive layout decision](../../../../knowledge/decisions/recursive-compound-layout.md)
- Svelte Flow's [Dagre layout example](https://svelteflow.dev/examples/layout/dagre)
- `front-end/src/core/containment.ts` from T01
- Current subflow collapse dimensions in `DiagramCore.toggleSubflow()`

## Invariants

- Input arrays and their node/data objects are not mutated.
- Only geometry fields, expanded subflow size metadata and parent-before-child
  ordering may differ in the returned nodes.
- Direct children always receive parent-relative positions.
- Hidden nodes participate in calculation exactly like visible nodes.
- Layout does not change edge objects or semantic graph data.

## Allowed files

- Only the manifest, lockfile, `front-end/src/layout/` and focused test file
  listed in `write_scope`.
- Add `@dagrejs/dagre` as the layout dependency. Add separate declaration
  support only if the package's installed TypeScript surface requires it.

## Out of scope

- Applying the result to `DiagramCore`.
- Svelte components, viewport behavior or handle rendering.
- Edge routing and user-configurable spacing.

## Work

1. Define the semantic direction type and the internal Dagre rank-direction
   mapping.
2. Implement dimension resolution from measured, explicit and safe fallback
   sizes without accessing the DOM.
3. Implement recursive bottom-up scope layout, top-left conversion,
   normalization, padding/header insets, coordinate rounding and stable output
   ordering.
4. Preserve compact visible dimensions for collapsed subflows while updating
   their stored expanded dimensions and laying out hidden descendants.
5. Add focused tests for sequential graphs, forks/joins, skip connections,
   disconnected nodes, resizing, nested subflows, collapsed subflows,
   orientation and repeated-call stability.

## Acceptance criteria

- [ ] Vertical ranks increase on the y-axis; horizontal ranks increase on the
      x-axis.
- [ ] Direct children never overlap and remain within their expanded parent.
- [ ] Nested subflow bounds are included before their parent scope is laid out.
- [ ] Both expansion and shrinkage are demonstrated by tests.
- [ ] Collapsed subflows retain compact visible size and correct future expanded
      size.
- [ ] Disconnected nodes are placed without overlap.
- [ ] Two calls with identical input return identical geometry.
- [ ] Source nodes, edges and semantic node data remain unchanged.
- [ ] No changes occur outside `write_scope`.

## Validation

Run from the repository root:

```bash
pnpm --dir front-end test -- src/__tests__/layout.test.ts
pnpm --dir front-end check
```

## Required handoff

Return:

- files changed and a concise explanation of each change;
- exact commands run and their results;
- chosen spacing, padding, fallback dimensions and rounding policy;
- evidence that nested/collapsed cases are stable;
- unresolved visual tradeoffs or follow-up work.
