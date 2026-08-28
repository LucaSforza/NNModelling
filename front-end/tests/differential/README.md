# Deterministic model conformance

This directory contains protocol v2 fixtures for the three currently supported
shape-semantic model scenarios. The wire format is deliberately independent of
Svelte, NNTree, Cordis fibers, editor coordinates, and Python objects:

- `protocolVersion: 2` and `operation: "infer-model"` identify the protocol;
- `packages` selects package ids;
- `nodes` is a topologically ordered list of `{id, packageId, parameters, inputs}`;
- `output` selects the single model result node.

`candidate-adapter.ts` loads the copied NNModelling packages and the new
frontend `TypeSystemHost`. `oracle-adapter.ts` loads the same requested package
ids from the ignored reference checkout in independent Bun processes. The
conformance test compares canonical outcomes and asserts the pinned oracle
revision `ef3efb1859b4a9c19227dd55aade65767fd4b1f5`.

## Scenarios

- `transformer.json`: token input, QKV/projection and FFN linear transforms,
  with two residual `Add` joins. Output is `['B', 'T', 512]`, `float32`.
- `variational-autoencoder.json`: image encoder, mean/log-variance branches,
  latent `Concat`, and decoder. Output is `['B', 784]`, `float32`.
- `resnet.json`: four-dimensional feature-map skeleton with three residual
  `Add` blocks and a classifier projection. Output is `['B', 224, 224, 1000]`,
  `float32`.

The reference standard library has no convolution, activation, normalization,
attention, sampling, or pooling packages. These fixtures therefore prove the
available shape/type contracts and residual/composition wiring; they do not
claim executable convolutional, attention, or VAE sampling semantics. Adding
those packages is a separate migration slice and must copy their reference
implementation when they become available.

Protocol v1 input requests remain supported by both adapters so the T01
regression suite can run while v2 model conformance is introduced. Fuzzing,
shrinking, and generated invalid graphs are intentionally deferred.
