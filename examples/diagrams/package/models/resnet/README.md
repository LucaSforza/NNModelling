# ResNet MNIST project

This project uses the MNIST handwritten-digit dataset for classification. The
local dataset files are intentionally ignored because they are generated data:

- `datasets/resnet-mnist/data/train.jsonl`: 60,000 examples;
- `datasets/resnet-mnist/data/test.jsonl`: 10,000 examples.

Each JSONL record contains an `image` array of 784 raw `uint8` pixels in row
major order (`28 x 28`) and an integer `label` from 0 to 9.

## Obtaining the data

MNIST is available from the original database page maintained by Yann LeCun:

<https://yann.lecun.com/exdb/mnist/>

Download the four official IDX archives:

```text
https://yann.lecun.com/exdb/mnist/train-images-idx3-ubyte.gz
https://yann.lecun.com/exdb/mnist/train-labels-idx1-ubyte.gz
https://yann.lecun.com/exdb/mnist/t10k-images-idx3-ubyte.gz
https://yann.lecun.com/exdb/mnist/t10k-labels-idx1-ubyte.gz
```

Convert the IDX archives to the two JSONL files above, keeping one image and
its label on each line. Do not commit either the downloaded archives or the
generated JSONL files.

The checked-in `dataset.py` reads these JSONL files directly. Prepare them
before training; the worker does not download missing data. Full MNIST JSONL
files can exceed the default backend expanded-file limit, so coordinate a
finite larger limit with the backend operator or use a smaller first-run dataset.
