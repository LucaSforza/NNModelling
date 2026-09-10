# ResNet MNIST example

This example uses a trained NNModelling wheel to classify one image. The
script applies the dataset's MNIST preprocessing and passes the resulting
tensor to the wheel's declared tensor contract.

After training `resnet.json` in NNModelling and downloading the wheel into this
directory, create the standalone environment and run the example:

```bash
cd examples/resnet_mnist
uv sync
uv run python classify.py /absolute/path/to/digit.png
```

The installed wheel exposes `nnm_resnet_mnist.Model`; the example loads it
with `Model()` and calls `predict_tensor`. Images should contain one grayscale
digit; ordinary PNG or JPEG files are accepted and resized and normalized for
the `[1, 1, 28, 28]` model input.
