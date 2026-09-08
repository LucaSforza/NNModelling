---
id: T02
kind: task
status: ready
plan: ../plan.md
role: frontend
depends_on: [T01]
parallel_with: []
write_scope:
  - front-end/src/Diagram.svelte.ts
  - front-end/src/type-system/editor-runtime.ts
  - front-end/src/type-system/packages/
  - front-end/src/__tests__/
---

# Make package activation follow the current model

## Objective

Replace global custom activation during model load with a staged
`core + current-model-custom` runtime scope and dispose the old custom scope on
successful model switch.

## Context required

- T01's model manifest parser and tests
- [Model-scoped package decision](../../../../knowledge/decisions/model-scoped-stereotype-packages.md)
- Existing `EditorTypeSystemRuntime`, `PackageCatalog`, and Diagram import seam

## Invariants

- Core packages remain active and globally available.
- Only manifest-listed model packages can enter the active catalog or palette.
- Failed preparation leaves the previous graph and custom runtime untouched.
- The old and new custom scopes never coexist after a successful switch.
- `DiagramCore` remains the graph authority; runtime code only coordinates
  package resources and inference.

## Work

1. Add a model-scope runtime/source resolver that loads package directories
   from the validated model bundle.
2. Stage the new package catalog and Cordis package fibers before committing a
   model graph.
3. Replace the previous custom scope, runtime diagnostics, and package palette
   only after successful preparation.
4. Add focused tests for initial core-only state, VAE→ResNet, ResNet→VAE,
   missing package, duplicate identity, and failed activation transitions.

## Acceptance criteria

- [ ] `availablePackages()` exposes core plus only current-model packages.
- [ ] Switching models removes old package definitions and diagnostics.
- [ ] Failed switching preserves the prior graph and package state.
- [ ] No package is activated solely because a node contains its ID.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/packageLifecycle.test.ts src/__tests__/packageEditorModels.test.ts
pnpm --dir front-end check
```

## Required handoff

Report lifecycle state transitions, disposal evidence, focused test results, and
any browser/MCP behavior requiring T05.
