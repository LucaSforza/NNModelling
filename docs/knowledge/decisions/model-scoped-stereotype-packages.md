---
kind: decision
status: accepted
updated: 2026-08-29
---

# Model-scoped custom stereotype packages

## Context

The package runtime now knows how to install and activate external packages,
but model loading still has no ownership boundary for custom stereotypes. A
package that happens to be installed or active can therefore appear unrelated
to the model being edited. This is especially misleading for the VAE example:
sampling and KL divergence are model-specific operations, not core library
operations.

## Decision

- Every package-native model JSON has a required top-level `manifest` object.
- The model manifest contains the model identity and a `customPackages` list.
  Each entry identifies exactly one model-owned package by `id`, `version`, and
  a package-directory `path` relative to the model bundle.
- The model manifest is source metadata. It does not replace the
  `manifest.json` inside a stereotype package and does not contain executable
  code.
- Bundled core packages remain globally active and available to every model.
  They are not repeated in `customPackages`.
- Only the packages listed by the current model manifest may be activated as
  model custom packages. Installed packages that are not listed are not
  searched, inferred, or added to the current editor palette.
- Model custom package directories are physically owned by the model bundle.
  Their package manifest must match the manifest entry's exact `id` and
  `version`; paths must remain relative and inside that bundle.
- The active package scope is exactly `core + current-model-custom`. On model
  switch, the previous model custom scope is replaced as part of the commit;
  its fibers, catalog entries, palette entries, inference registrations, and
  runtime diagnostics are disposed before the new scope is exposed.
- Model switching is staged: parse and validate the new manifest and package
  closure, activate the new custom scope, and only then commit the new graph.
  If preparation fails, the previous model and its package scope remain
  unchanged.
- The backend receives the resolved package bundle, not model-relative paths.
  The bundle contains the complete resource closure, including every declared
  `pytorch.py` required by the graph. Model-local Python entrypoints therefore
  travel with the core package resources through the existing backend bundle
  protocol.

## Model manifest shape

The v1 shape is intentionally small and explicit:

```json
{
  "manifest": {
    "schemaVersion": 1,
    "id": "example.vae-mnist",
    "version": "0.1.0",
    "name": "Variational Autoencoder",
    "description": "MNIST variational autoencoder",
    "customPackages": [
      {
        "id": "example.vae.sampling",
        "version": "0.1.0",
        "path": "packages/sampling"
      },
      {
        "id": "example.vae.kl-divergence",
        "version": "0.1.0",
        "path": "packages/kl-divergence"
      }
    ]
  },
  "nodes": []
}
```

`customPackages` is the complete model-owned package set, not a hint. A
package reference in a node is valid only when it is a core package or an
exact package in this list. Package manifests retain their own static
dependencies; dependencies must resolve within the core set or this model's
custom set. No global library or automatic dependency discovery is introduced
in v1.

## Lifecycle and ownership

```text
core package records ────────────────┐
                                     ├─> active model scope
model manifest + relative directories┘       = core + custom packages
                                                   │
                                                   v
                                      DiagramCore + Lua inference + bundle
```

With no model open, only the core scope is active. Opening or importing a
model first prepares its scope without mutating `DiagramCore`; after a
successful commit, the old custom package fibers and diagnostics are disposed.
The browser remains the sole graph authority and the MCP server remains a thin
proxy.

## Example ownership

- ResNet declares `customPackages: []` and uses only core packages.
- The canonical VAE declares the model-owned Sampling and KL divergence
  packages. Their package directories move out of `stereotype-packages/core/`
  and live beside the VAE model under its bundle root.
- Generic operations such as `Scale`, `MSE`, `Add`, and `Repeat` remain core
  only when they are genuinely shared by models.

## Non-goals

- A shared model-package library, marketplace, discovery service, or package
  deduplication policy.
- Making every installed external package active for every model.
- Changing Lua or PyTorch package semantics, package dependency rules, or the
  backend sandbox boundary.
- Persisting filesystem handles or absolute paths in model JSON.
