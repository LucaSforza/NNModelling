Examples
========

Editable examples live in ``examples/diagrams/package/models/``. Each model is
a self-contained package graph; the model manifest owns any custom package
resources and the browser uploads the resolved bundle.

VAE
---

``examples/diagrams/package/models/variational-autoencoder/model.json`` shows a
package graph with an explicit prediction output and objective subgraph. Its
manifest carries the model-owned Sampling and KL divergence packages under
``packages/``. Train it from the Training sidebar with the MNIST autoencoder
dataset. Download the portable wheel from the completed job and use its public
runtime API for reconstruction or generation.

ResNet classifier
-----------------

``examples/diagrams/package/models/resnet/model.json`` demonstrates convolution, pooling,
flattening and a linear classifier. Add the package Cross Entropy objective;
targets come from the selected dataset adapter, not from a graph node.

The examples are intentionally editable source diagrams. Historical compiled
artifacts are not an input to the supported backend.
