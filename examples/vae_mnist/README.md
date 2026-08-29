# VAE MNIST wheel consumer

This standalone `uv` project consumes the package-native wheel exported by
NNModelling. It does not import NNModelling or the training checkout.

Keep the downloaded wheel in this directory, then run the 1→7 latent
interpolation in the standalone environment:

```bash
cd examples/vae_mnist
uv sync
uv run python interpolate.py
```

The script imports `Model` directly from the downloaded job package. It reconstructs
two local MNIST fixtures through `Model.predict`, obtains their posterior means
through the public `encode` adapter, and decodes several interpolated latent
points through the public `forward` adapter. The result is written to
`generated/interpolation-1-to-7.png`.

The wheel embeds the graph and trained safetensors state. No `--wheel`,
`--package-name`, `sys.path`, `importlib`, private runtime, or repository data
path is needed at runtime.
