Examples
========

Editable examples live in ``examples/diagrams/package/``. They are package
graphs consumed by the browser and uploaded as authenticated bundles.

VAE
---

``examples/diagrams/package/variational-autoencoder-complete.json`` shows a
package graph with an explicit prediction output and objective subgraph. Train
it from the Training sidebar with the MNIST autoencoder dataset. Download the
portable wheel from the completed job and use its public runtime API for
reconstruction or generation.

ResNet classifier
-----------------

``examples/diagrams/package/resnet.json`` demonstrates convolution, pooling,
flattening and a linear classifier. Add the package Cross Entropy objective;
targets come from the selected dataset adapter, not from a graph node.

The examples are intentionally editable source diagrams. Historical compiled
artifacts are not an input to the supported backend.
