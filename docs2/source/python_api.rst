Use an exported model in Python
===============================

The supported consumer API lives in the wheel downloaded after successful
training. Its import name is the ``nnm_<name>`` selected at download time.
You do not need this repository, the editor, the backend or the training
dataset to load it.

Install and load
----------------

Install the actual downloaded filename into your own Python project:

.. code-block:: console

   $ uv add /path/to/nnm_my_model-0.1.0-py3-none-any.whl

Then import its public facade:

.. code-block:: python

   from nnm_my_model import Model

   model = Model(device="cpu")

``Model`` loads the embedded safetensors weights by default. The wheel declares
its inference dependencies; a clean environment still needs those installed.
The compatibility factory ``load_model(device="cpu")`` delegates to ``Model``.

Predict from tensors
--------------------

Use ``predict_tensor`` for a batch that already has the exported input shape,
dtype and preprocessing. For a single-input model:

.. code-block:: python

   # batch is your already-preprocessed torch.Tensor.
   prediction = model.predict_tensor(batch)

For multiple inputs, use their exact graph binding names:

.. code-block:: python

   prediction = model.predict_tensor({
       "tokens": tokens,
       "attention_mask": attention_mask,
   })

This example applies to a model exported with those two bindings. Consult your
model's input contracts rather than copying the names into an unrelated model.
The leading batch dimension remains dynamic; the exported non-batch dimensions
and dtypes describe what the model expects.

Prediction executes the explicit prediction program. It does not execute the
training objective or require dataset targets.

Preprocessing and named adapters
--------------------------------

For a single-input model, ``predict(value)`` applies its packaged input adapter:

.. code-block:: python

   prediction = model.predict(value)

The accepted value depends on that model's adapter. Do not assume every model
accepts image filenames or performs the same normalization. For tensors you
have prepared yourself, prefer ``predict_tensor``.

Some models declare additional public adapters, accessed through
``model.adapter(name).run(...)``. For example, the VAE consumer uses declared
sampling and forward adapters. Their names and arguments belong to that
exported model; they are not universal methods on every wheel.

External weights
----------------

You can load a compatible local checkpoint instead of the embedded weights:

.. code-block:: python

   model = Model(weights="checkpoints/candidate.safetensors", device="cpu")

The file must be safetensors for the same exported architecture. Loading checks
its architecture fingerprint and tensor names, shapes and dtypes. Missing,
extra or incompatible tensors fail loading; there is no partial load or silent
fallback to the bundled weights.

Backend implementation map
--------------------------

For contributors integrating the training service, these are implementation
modules inside ``converted/src/``, not imports required by wheel consumers:

.. list-table::
   :header-rows: 1
   :widths: 35 65

   * - Module
     - Responsibility
   * - ``package_runtime.compiler``
     - Compile a package graph into prediction and objective views sharing
       trained modules.
   * - ``package_worker``
     - Run dataset loading and training inside the configured worker container.
   * - ``backend.app``
     - HTTP endpoints for pairing, uploads, jobs, logs, events and artifacts.
   * - ``backend.manager``
     - Coordinate Valkey scheduling and container lifecycle.
   * - ``model_package.exporter``
     - Build the self-contained prediction wheel and artifact metadata.

The backend accepts package bundles and typed requests. Historical NNTree
conversion and host-training commands are not part of this public workflow.
