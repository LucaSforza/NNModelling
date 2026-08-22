---
id: T08-three-models-evidence
kind: evidence
task: ../tasks/T08-graph-differential-fuzzing.md
reference_revision: ef3efb1859b4a9c19227dd55aade65767fd4b1f5
updated: 2026-08-22
---

# Three-model frontend milestone

## Observable result

The frontend activates bundled package resources through the Cordis-owned host,
drives package Lua from a read-only editor graph snapshot, preserves ordered
join handles, and exposes JSON-safe package inference through browser RPC. New
nodes persist exact package ID/version and display name. The deprecated
`TypeEngine` remains only for legacy nodes; new package nodes render shape,
dtype and diagnostics from the package scheduler.

Saved fixtures are available under `examples/diagrams/package/` for a
Transformer block, variational autoencoder and product ResNet. The product
ResNet is a real NCHW residual path ending in `core.linear` with output
`["B", 1000] float32`.

## Differential evidence

Protocol-v2 candidate and oracle runners execute as separate Bun processes.
The deterministic Transformer, variational-autoencoder and reference-compatible
ResNet fixtures all produced identical canonical observations. The product
ResNet is candidate-only because its extra convolutional primitives are the
bounded NNModelling product slice rather than reference packages.

## Reuse ledger

| Reference source | NNModelling destination | Disposition |
| --- | --- | --- |
| `packages/core/{add,cast,concat,cross-entropy,embedding,horizontal-repeat,input,linear,repeat}/` | matching `stereotype-packages/core/` packages | copied byte-for-byte where the browser contract permits |
| `src/lua/lua-inference-runtime.ts` and tests | `front-end/src/type-system/lua/` and focused Vitest cases | copied; imports/test host adapted |
| `src/packages/` catalog, registry, loader and validation | `front-end/src/type-system/packages/` | adapted for Vite resource delivery and normative fault separation |
| reference model/test shapes | `front-end/tests/differential/models/` | adapted into protocol-v2 semantic graphs |
| filesystem package discovery | `front-end/src/type-system/bundled/catalog.ts` | not used; replaced by the required browser `import.meta.glob` adapter |
| editor graph scheduling and persistence | `front-end/src/type-system/graph/` | NNModelling-specific adapter over `DiagramCore`; no second mutable graph |
| Conv2d/BatchNorm2d/ReLU/pooling/flatten product packages | `stereotype-packages/core/` | NNModelling product extension; generic host path, no package-ID dispatch |

## Verification

- Pinned oracle `bun test`: 25 passed.
- Frontend unit suite: 442 passed, 5 skipped.
- Three-model differential command: 3 passed.
- Editor model round-trip suite: 4 passed.
- `svelte-check`: 0 errors; 11 existing warnings.
- Production Vite build completed.
- Live editor rendered the Transformer and product ResNet without package
  diagnostics; browser RPC reported one terminal and successful typed outputs.

## Deferred work

This milestone does not claim full T03–T07 parity. Structured compositional
diagnostic frames, editor schema controls, nested subflow scheduling, complete
reference-suite accounting and generative differential fuzzing remain active
frontend work. Backend/PyTorch loading remains entirely excluded.
