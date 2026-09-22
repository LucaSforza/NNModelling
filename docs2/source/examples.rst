Example projects
================

Editable projects live in ``examples/diagrams/package/models/``. Copy a whole
project directory to a writable location, then select it with **Open project**.
The editor saves changes automatically, including when you open an example
inside the checkout.

Each project's ``model.json`` declares its custom stereotypes and datasets.
Keep those relative directories together. Historical compiled NNTree files
are not editable projects or inputs to the package training backend.

VAE: image reconstruction
-------------------------

Project: ``examples/diagrams/package/models/variational-autoencoder/``.

This graph demonstrates an encoder/decoder, model-owned sampling and KL
packages, an explicit prediction Output, and reconstruction and KL objectives.
The project dataset is **Autoencoder MNIST** (``example.vae-mnist@0.1.0``).
It binds ``image`` and ``target`` to float32 tensors of shape ``[B, 1, 28, 28]``.

Prepare these files inside the copied project before training:

.. code-block:: text

   datasets/autoencoder-mnist/data/train.jsonl
   datasets/autoencoder-mnist/data/test.jsonl

Each non-empty line is a JSON object with an ``image`` array of exactly 784
integer pixels in row-major order, each from 0 to 255. The loader reads JSONL,
normalizes the image and uses it as both input and target. Data files are
ignored by Git and are not supplied merely by cloning the project. The project
README describes obtaining and converting MNIST data.

In Training, select Autoencoder MNIST, review ``B``, ``num_workers`` and
``train_size``, then follow :doc:`training_user_guide`. A trained wheel can
reconstruct images through its prediction API and expose the model's declared
sampling adapters.

ResNet: digit classification
----------------------------

Project: ``examples/diagrams/package/models/resnet/``.

This graph demonstrates convolution, residual branches, pooling, flattening
and classification. It already includes its Cross Entropy objective; do not
add another loss merely to follow this guide.

The dataset **ResNet MNIST** (``example.resnet-mnist@0.1.0``) supplies float32
``image`` tensors of shape ``[B, 1, 28, 28]`` and int64 ``target`` labels of
shape ``[B]``. Prepare:

.. code-block:: text

   datasets/resnet-mnist/data/train.jsonl
   datasets/resnet-mnist/data/test.jsonl

Each JSONL record contains the same 784-pixel ``image`` array as the VAE data,
plus an integer ``label`` from 0 to 9. The checked-in loader already supports
this format. Review ``train_size`` before running: it determines how much of
the training file is used for training versus validation.

Data size and first runs
------------------------

The loader splits the training file into training and validation sets; the test
file supplies a separate test loader. Supply enough records for the chosen
split to be useful. The complete MNIST JSONL files can exceed default backend
limits, particularly the expanded per-file cap. Coordinate a finite larger
limit with the operator or prepare a smaller dataset for a first smoke run;
see :doc:`training_admin_guide`.

The backend cannot fetch absent project data for you. Opening a graph proves
that its project resources can load, not that its full dataset is present or
that it has completed training.

Standalone wheel consumers
--------------------------

``examples/vae_mnist/`` and ``examples/resnet_mnist/`` contain independent
Python consumer projects with their own READMEs. They install the downloaded
wheel and import its public ``Model`` facade. Follow their package naming and
input requirements; :doc:`python_api` explains the common wheel interface.
