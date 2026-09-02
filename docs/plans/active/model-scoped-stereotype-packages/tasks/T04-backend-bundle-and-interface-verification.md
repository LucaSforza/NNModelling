---
id: T04
kind: task
status: ready
plan: ../plan.md
role: integration
depends_on: [T02, T03]
parallel_with: []
write_scope:
  - front-end/src/training/
  - front-end/src/__tests__/packageBundle.test.ts
  - converted/src/tests/test_package_runtime.py
  - docs/knowledge/contracts/model-package.md
---

# Export model-scoped resources through the existing backend bundle

## Objective

Prove that the package bundle is built from the active model scope and carries
all required model-local Python entrypoints with the other package resources,
without exposing model filesystem paths or inventing a second transport.

## Context required

- T02's active model scope
- T03's model-local package layout
- [Package backend decision](../../../../knowledge/decisions/package-backend-standard.md)
- Existing `buildPackageBundle()` contract and backend runtime tests

## Invariants

- Bundle contents are immutable resolved bytes, not model-relative paths.
- Every package in the graph closure has its declared manifest, definition,
  Lua, Python and helper files as applicable.
- ResNet bundles do not include VAE-only resources.
- VAE bundles include Sampling and KL divergence `pytorch.py` resources.
- Backend execution remains behind the existing worker/container boundary.

## Work

1. Feed the active model package scope into the existing bundle export seam.
2. Assert complete VAE closure and absence of VAE resources from ResNet.
3. Keep model manifest metadata separate from package manifests in the payload.
4. Update the model-package contract with the verified source-to-bundle path.

## Acceptance criteria

- [ ] VAE bundle contains both model-local Python entrypoints and helper files.
- [ ] ResNet bundle contains only packages required by its graph.
- [ ] No client path reaches backend validation or execution.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/packageBundle.test.ts
cd converted && uv run pytest src/tests/test_package_runtime.py -q
```

## Required handoff

Report exact bundle package IDs/resources and any mismatch between frontend
scope and backend closure.
