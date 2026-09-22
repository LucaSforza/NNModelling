Train a model
=============

Training runs on a separately managed backend. You need an open project, its
local dataset files, a valid prediction graph and an objective. The browser
uploads an immutable snapshot, so later edits do not change an already submitted
job.

Connect to a backend
--------------------

1. Open the **Training** sidebar.
2. Enter the **Backend URL** supplied by the operator and, optionally, a
   device name.
3. Select **Request connection**. The sidebar displays a pairing code while
   approval is pending.
4. Ask the operator to compare that code with the pending request on the
   backend machine and approve it. Wait for **Connected**.

The sidebar displays the connection's expiry. Use **Request renewal** when an
expired connection needs new approval. **Forget on this browser** removes the
local connection; **Disconnect and revoke** also revokes its backend access.
Jobs and uploaded resources belong to the authenticated connection. Another
browser or newly paired connection does not automatically acquire them.

Operators can follow :doc:`training_admin_guide` for startup, allowed origins
and pairing commands.

Prepare the dataset and graph
-----------------------------

Select a dataset from the active project in **Dataset**. Fill the parameters
it declares; there is no universal dataset form. For the bundled MNIST
examples, ``B`` is batch size, ``num_workers`` controls loader workers, and
``train_size`` controls the training/validation split.

Before submission, check that:

* local data files required by ``dataset.py`` exist inside the dataset;
* each Input's ``binding`` matches a named ``batch.inputs`` slot;
* the graph has an explicit Output for prediction;
* each objective is connected to its prediction value, and its declared
  target sources match ``batch.targets``;
* required parameters are filled and no hard type errors remain.

An image model may need Flatten before a Linear layer; the dataset's
``[B, C, H, W]`` contract does not flatten its tensors automatically. For
classification with Cross Entropy, supply logits rather than applying Softmax
before the loss.

See :doc:`examples` for the VAE and ResNet projects and their data requirements.

Choose training settings
------------------------

Set the seed, optimizer and learning rate, epoch limit, accelerator and early
stopping settings. Set CPU, RAM and GPU requests to values supported by the
backend. Dataset parameters and training settings are typed values; arbitrary
Python import targets or free-form configuration overrides are not accepted.

Choose a W&B mode:

``disabled``
   Run without W&B tracking.
``offline``
   Record W&B data locally in job artifacts, with no W&B network access.
``online``
   Use the account and restricted network configured by the operator. This
   mode is available only when the backend advertises it as configured.

The editor selects the W&B project and mode. API keys, account entity and
network policy are configured on the backend, not entered in the browser.

Submit and follow progress
--------------------------

Submit from the sidebar. The browser validates and uploads the selected
project dataset as a complete archive, uploads the package bundle, then
creates the job. A failed dataset upload does not create a job. Review the
advertised archive limit; :doc:`datasets` explains upload constraints.

Follow status, logs and events in the sidebar. Jobs normally move from queued
to running and then to succeeded, failed or cancelled. Use the job's diagnostic
and logs to investigate failures; a successful upload alone is not successful
training. Cancellation requests stop queued or running work through the backend.

W&B finalization can continue after the epoch loop. Wait for a terminal job
state before deciding whether the run completed. Terminal offline runs also
provide a downloadable W&B archive.

Download and use the model
--------------------------

On success, download the Python wheel and choose an importable package name
in the form ``nnm_<name>``, for example ``nnm_my_model``. Naming happens at
download time; it does not rename or rerun the job. The browser verifies the
checksum before saving the download.

The wheel includes the prediction graph, required package resources, input
contracts, selected adapters and trained safetensors weights. It excludes the
training dataset and does not need the NNModelling checkout or backend.

Install it in your own Python project and use its public ``Model`` API; see
:doc:`python_api`. Prediction does not require targets. Multiple named inputs
must be passed to ``predict_tensor`` as a mapping keyed by binding name.
