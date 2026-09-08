# Documentation-backed future work

This is a non-normative backlog. It records desired directions without turning
them into accepted architecture or unfinished requirements of completed work.
Before starting an item, inspect the then-current repository and create a
bounded plan under `docs/plans/active/`.

## Package backend

- Design and implement independent trusted `pytorch.py` loading for package
  graphs.
- Start from the current Python compiler/runtime at that time and the pinned
  [reference PyTorch contract](https://raw.githubusercontent.com/LucaSforza/stereotype-lab/ef3efb1859b4a9c19227dd55aade65767fd4b1f5/design/stereotype-specification/04-pytorch-runtime.md).
- Preserve Lua as the sole type-inference authority; do not infer types by
  executing PyTorch.

## External stereotype packages

- Allow users eventually to obtain trusted stereotype packages published by
  other people on GitHub.
- Before implementation, design explicit discovery sources, download,
  integrity, trust, version selection, installation and the frontend/backend
  delivery boundary.
- Package managers, dependency solvers, lockfiles, provenance enforcement, hot
  reload and Python sandboxing remain temporary non-goals.
- Keep the current bundled package and lifecycle implementation while it
  remains sufficient; do not add machinery without a concrete use case.

## Large project datasets

- Project-dataset transport v1 intentionally uses one bounded, non-resumable
  archive upload and is suitable only for small and medium datasets.
- Design multipart/resumable transfer, object storage, partial retry, quotas,
  retention and garbage collection before claiming support for datasets beyond
  the backend-advertised v1 byte limit.
- Preserve the project-owned manifest, named batch and worker-only execution
  contracts when a scalable transport is introduced; transport scale must not
  create external host paths or a second dataset semantics.

## Type-system evidence

- Add richer deterministic package models. Current Transformer, VAE and ResNet
  scenarios prove useful semantic slices but are not the final realistic model
  corpus.
- Expand property-based candidate/oracle testing beyond the current bounded
  linear/Add DAGs to cover more schemas, kinds, ordered joins, dtypes, dynamic
  references, nested subflows and targeted invalid scenarios.
- Later decide shrinking, retained divergence corpus, local/CI budgets and the
  exact division between shared-package and product-package modes.
- Keep `stereotype-lab` pinned as the semantic reference and complement
  differential equality with independent properties.

## Deliberately simple type model

- Keep the current `shape + dtype` model with nominal symbolic dimensions.
- Add constraints, equations, symbolic broadcasting, partial types, additional
  tensor properties or richer diagnostics only in response to demonstrated
  model requirements.
