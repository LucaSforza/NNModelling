---
id: T02
kind: task
status: complete
plan: ../plan.md
role: integration
depends_on: [T01]
parallel_with: []
write_scope:
  - docs/plans/active/nnc-linear-graph/evidence/
---

# Verify docking in the Browser

## Objective

Exercise the actual drag-and-drop gesture on a branching diagram and prove the
visual docking and logical edge state separately.

## Context required

- [`../plan.md`](../plan.md)
- The active NNModelling page in the Codex in-app Browser.
- `examples/diagrams/package/variational-autoencoder-complete.json`
- Browser-backed MCP graph validation tools.

## Invariants

- Use the Codex in-app Browser cursor for the actual node drag and drop.
- Do not import a display-only graph or manually add an edge as a substitute
  for the pointer gesture.
- Validate the rendered group and logical graph state after the gesture.

## Allowed files

- `docs/plans/active/nnc-linear-graph/evidence/` only, and only for useful
  screenshots or concise validation output.

## Out of scope

- New UI or package implementation.

## Work

1. Load the saved VAE fixture.
2. Move a small test node or an existing compatible node so its target handle
   overlaps an output handle, then release.
3. Confirm the node arrangement, hidden edge layer, edge count, and valid type
   inference.
4. Inspect the rendered edge count and docked group to prove the edge is
   persisted logically while its stroke stays hidden.

## Acceptance criteria

- [ ] The gesture creates the expected source/target edge.
- [ ] No connector stroke is visible after the drop.
- [ ] Type inference remains successful.
- [ ] No NNC toolbar button is present.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/utils.test.ts
pnpm --dir front-end check
git diff --check
```

## Required handoff

Return observed visual behavior and logical graph evidence.
