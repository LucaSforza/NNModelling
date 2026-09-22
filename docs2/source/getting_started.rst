Getting started
===============

This guide gets you to an editable, locally saved project. You do not need a
training backend to create a graph or inspect its tensor types.

Run the editor
--------------

From a source checkout, install the JavaScript workspace and start Vite:

.. code-block:: console

   $ pnpm install --frozen-lockfile
   $ pnpm --dir front-end dev --host 127.0.0.1 --port 5174

Open the local URL printed by Vite. This guide uses
``http://127.0.0.1:5174``; if that port is occupied, use the actual printed URL.
When configuring a training backend, its allowed origins must include that
exact origin, including the port.

The web editor needs the browser's File System Access API and permission to
write the selected project directory. If your browser cannot provide writable
directory access, use :doc:`desktop`. The desktop application uses the same
project format and editor.

Create a project
----------------

1. Choose **New project** on the project chooser.
2. Select the parent directory where the project should live.
3. Enter the model ID, version, display name and optional description.
4. Confirm creation. NNModelling creates a child directory named after the
   model ID, writes ``model.json`` and opens the editor. An existing directory
   with that ID is rejected rather than overwritten.

Graph changes are saved automatically. Check the save status before closing
or switching projects. See :doc:`user_guide` for the project layout and recovery
from failed writes.

Open an example
---------------

For a populated graph, copy an entire example directory to a writable location,
then choose **Open project** and select that copied directory. Select the
folder containing ``model.json``, not the JSON file itself.

Start with the VAE project:

.. code-block:: text

   examples/diagrams/package/models/variational-autoencoder/

Keep its ``packages/`` and ``datasets/`` resources together with ``model.json``.
The manifest refers to those resources by relative path. Copying only the JSON
leaves the custom stereotypes and dataset unavailable. Use a copy because
editing the original example will save changes into the checkout.

The :doc:`examples` page explains what each example demonstrates and which
resources need preparation before training.

Understand the first graph
--------------------------

A typical trainable graph has two branches after its prediction value:

.. code-block:: text

   Input -> feature layers -> prediction -> Output
                                        \-> Loss
                                             ^
                                    dataset target binding

* **Input** selects a named input from the project's chosen dataset. That
  dataset supplies the tensor shape and dtype.
* **Layers** transform tensors. A **join** combines ordered graph inputs.
* **Output** identifies the value returned by the exported prediction model.
* **Loss** computes the training objective. Target tensors come from the
  dataset, through declared target bindings.

Dataset selection is necessary for complete inference of regions that depend
on Input nodes. An unresolved tensor before selecting a dataset is not itself
an invalid model. Continue with :doc:`datasets`, then
:doc:`training_user_guide` when ready to train.
