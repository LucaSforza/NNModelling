---
id: T04
kind: task
status: ready
plan: ../plan.md
role: integration
depends_on: [T02, T03]
parallel_with: []
write_scope:
  - examples/diagrams/package/models/variational-autoencoder/
  - examples/vae_mnist/
  - front-end/src/__tests__/
  - converted/src/tests/
---

# Migrate and statically validate the VAE example

## Objective

Make the canonical VAE diagram, dataset, adapters and consumer example use the
new dataset-driven Input contract before system integration and real QA.

## Context required

- [Initiative](../plan.md)
- T02 and T03 handoffs
- VAE package diagram and `autoencoder-mnist` project dataset
- public VAE wheel interpolation consumer

## Invariants

- The diagram has no Input shape/dtype parameters.
- Every symbolic dataset dimension has a valid required integer parameter and
  positive example value.
- Portable image preprocessing and interpolation use declared model/package
  adapters, not dataset adapter metadata or compiler internals.
- Dataset files remain project-owned and confined.

## Allowed files

Only VAE example directories and directly focused tests in `write_scope`.

## Out of scope

- Real training, browser QA or unrelated example cleanup.

## Work

1. Migrate the VAE Input binding and dataset dimension parameters.
2. Remove dataset-owned inference adapter metadata and select the existing
   appropriate wheel adapters on model nodes.
3. Update focused fixtures and consumer tests for the resolved input contract.
4. Validate the diagram/dataset statically and run clean-wheel interpolation
   tests with a test artifact where available; leave real trained-wheel proof
   to T06.

## Acceptance criteria

- [ ] VAE diagram and dataset contain no legacy Input typing or dataset adapter.
- [ ] Static model+dataset validation succeeds with explicit dimension values.
- [ ] Consumer interpolation uses public wheel APIs only.
- [ ] Focused tests cover migration and adapter ownership.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test
cd converted && uv run pytest src/tests/test_model_package.py -q
uv run --project examples/vae_mnist pytest -q
git diff --check
```

## Required handoff

Return migrated files, selected parameter values/adapters, static validation
results, consumer test results and prerequisites for T05/T06.
