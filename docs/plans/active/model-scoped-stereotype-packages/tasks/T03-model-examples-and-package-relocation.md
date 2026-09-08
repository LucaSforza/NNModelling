---
id: T03
kind: task
status: ready
plan: ../plan.md
role: packages
depends_on: [T01]
parallel_with: [T02]
write_scope:
  - examples/diagrams/package/
  - examples/manifest.json
  - stereotype-packages/core/reparameterize/
  - stereotype-packages/core/kl-divergence/
  - front-end/src/__tests__/packageStandardLibrary.test.ts
  - front-end/src/__tests__/modelScopedPackages.test.ts
  - converted/src/tests/test_package_runtime.py
  - docs2/source/examples.rst
---

# Relocate model-owned VAE packages and update examples

## Objective

Make the example files express ownership: ResNet has no custom packages, while
the complete VAE carries and declares its Sampling/Reparameterize and KL
divergence packages in its own model bundle.

## Context required

- T01's manifest schema
- [Model-scoped package decision](../../../../knowledge/decisions/model-scoped-stereotype-packages.md)
- Existing VAE and ResNet package diagrams and package-standard tests

## Invariants

- VAE package manifests, definitions, Lua, Python and helper resources move
  together.
- VAE-owned packages no longer ship from the global `core` catalog.
- Shared `Scale`, `MSE`, `Add`, `Repeat`, and other genuinely generic packages
  remain core packages.
- The browser and backend continue to use the same exact package identity.

## Work

1. Create the model-owned VAE bundle layout and move the Sampling/Reparameterize
   and KL divergence package directories into it.
2. Update package IDs/namespaces and every VAE node reference consistently;
   do not add package-specific inference branches.
3. Add manifests to ResNet and all retained VAE fixtures, with an empty custom
   set where the fixture does not use custom packages.
4. Remove the two relocated packages from core catalog fixtures and move their
   focused inference/runtime assertions to the VAE fixture coverage.
5. Update the example index and relevant public/example references.

## Acceptance criteria

- [ ] ResNet declares `customPackages: []` and resolves only core packages.
- [ ] Complete VAE declares both model-owned packages and loads them from local
      directories.
- [ ] No VAE package directory remains under `stereotype-packages/core/`.
- [ ] Focused frontend and Python fixture tests use the new model-local paths.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/packageStandardLibrary.test.ts
cd converted && uv run pytest src/tests/test_package_runtime.py -q
```

## Required handoff

Report the final model/package layout, package identities, updated fixture
references, and any bundle-export expectation for T04.
