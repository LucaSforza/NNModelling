# ResNet MNIST example

This example uses a trained NNModelling wheel to classify one image. The wheel
declares the MNIST image adapter, so resize and normalization are performed by
the exported model instead of being duplicated in this script.

After training `resnet.json` in NNModelling and downloading the wheel, run:

```bash
PYTHONPATH=examples/resnet_mnist \
  uv run --project converted python examples/resnet_mnist/predict_digit.py \
  --wheel /absolute/path/to/nnm_resnet_mnist_reference-0.1.0-py3-none-any.whl \
  --package-name nnm_resnet_mnist_reference \
  --image /absolute/path/to/digit.png
```

The command prints the predicted digit and the three most likely classes.
Images should contain one grayscale digit; ordinary PNG or JPEG files are
accepted and resized to 28x28 by the wheel's public `ImageAdapter`.
