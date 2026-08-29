# ResNet MNIST example

This example uses a trained NNModelling wheel to classify one image. The wheel
declares the MNIST image adapter, so resize and normalization are performed by
the exported model instead of being duplicated in this script.

After training `resnet.json` in NNModelling and downloading the wheel into this
directory, create the standalone environment and run the example:

```bash
cd examples/resnet_mnist
uv sync
uv run python classify.py /absolute/path/to/digit.png
```

The installed wheel exposes `nnm_resnet_mnist.Model`; the example
loads it with `Model()` and calls its public `predict` method. Images should
contain one grayscale digit; ordinary PNG or JPEG files are accepted and
resized to 28x28 by the wheel's declared image adapter.
