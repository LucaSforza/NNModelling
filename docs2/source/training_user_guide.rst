Connect the frontend to a training backend
==========================================

The Training sidebar can send the diagram to an NNModelling backend running
either on the same computer or on another machine. The backend URL and pairing
workflow are unchanged: enter the backend URL, request a connection, and compare
the verification code with the administrator.

Local backend (same computer)
-----------------------------

Start the local companion — it serves the editor and starts the training
backend on localhost:

.. code-block:: bash

   pnpm --dir front-end build
   just --justfile converted/backend/justfile valkey
   PYTHONPATH=converted/src uv run --project converted python -m backend.cli

Open ``http://127.0.0.1:8000``. The Training Sidebar already defaults to the
``http://127.0.0.1:8000`` URL, so pairing with this process is a single
approval. No separate ``admin-init`` command is needed: the companion
provisions the local administrator token automatically on first start. No
remote server or cluster is involved.

Remote backend
--------------

To train on a server or Slurm cluster instead, leave the local companion
running (or not) and connect the sidebar to the remote backend URL as
described below. The companion never proxies, routes, or duplicates remote
jobs — selecting local versus remote training is simply which backend URL the
sidebar is connected to.

Connections use administrator-approved browser pairing: there are no
usernames or passwords, and an unapproved browser cannot inspect datasets,
compute units, jobs, logs, or events.

.. warning::

   This pairing system is designed for a trusted LAN. Do not expose the
   backend directly to the public Internet. Plain HTTP does not encrypt the
   bearer token; use HTTPS whenever the LAN is not fully trusted.

Before connecting
-----------------

Ask the backend administrator for its URL, for example
``http://192.168.1.20:8000``. The administrator must allow the exact Origin
from which your NNModelling frontend is served. An Origin includes scheme,
host, and port, such as ``http://192.168.1.30:5174``.

Only ``GET /health`` and the short pairing exchange are available before
approval. The administrator never needs to send you a password or token.

Request a connection
--------------------

1. Open NNModelling and select **Training** in the editor toolbar.
2. Enter the absolute HTTP or HTTPS backend URL.
3. Optionally enter a recognizable device name, such as
   ``Laptop laboratorio``.
4. Select **Richiedi connessione**.
5. Compare the six-digit code shown in the sidebar with the code seen by the
   administrator. Do not ask the administrator to approve if the codes differ.
6. Wait on the same screen. The frontend checks the request periodically and
   unlocks the training controls after approval.

The request itself expires after a short interval, normally ten minutes. A
rejected or expired request can be replaced by selecting the backend again and
creating a new one.

What the browser stores
-----------------------

The browser stores the backend URL, the opaque connection token, and the
connection identifier in ``localStorage``. Refreshing the page or restarting
the browser therefore preserves a non-expired connection.

Treat the browser profile as a credential: another process that can read its
site storage can act as this connection. The token is sent in the
``Authorization`` header and is never placed in a URL. Job events use an
authenticated fetch-based SSE stream for the same reason.

Session lifetime and renewal
----------------------------

The usual lifetime is 24 hours. The backend administrator can select a
different duration for one approval. The sidebar shows the current expiry
time.

When a connection expires, choose **Richiedi rinnovo**. The administrator must
approve the new request. A successful renewal keeps the same connection
identity, so jobs created before expiry remain visible.

A revoked connection cannot renew itself. It must pair as a new connection,
and the new identity does not inherit jobs owned by the revoked identity.

Submit and inspect training jobs
--------------------------------

After approval, the sidebar loads dataset classes and compute capabilities
from the backend. Configure the dataset, optimizer, trainer, W&B settings,
requested CPU/RAM/GPU resources, and priority, then select **Invia training**.

Priority is a non-negative integer. Larger values are scheduled first; equal
priorities retain FIFO order. The initial scheduler runs one compatible job at
a time and can use either the local machine or a configured Slurm executor.

Job states are:

.. code-block:: text

   queued -> running -> succeeded
                    |-> failed
                    `-> cancelled

Selecting **Invia training** opens a terminal-like tab for the new job. It
follows stdout and stderr incrementally while the job is queued or running,
and remains available afterwards from **Apri terminale**. Both queued and
running jobs can be cancelled.

With W&B mode set to ``online``, a second tab opens in a waiting state. It is
redirected to the live W&B run as soon as the remote training process reports
its public run URL. If the browser blocks a popup, the job row still exposes
**Apri W&B** once that URL is available.

Classification reports in W&B
-----------------------------

At the end of each test phase, classification models log a whole-test-set
report to W&B. It includes accuracy, macro precision/recall/F1, and
precision/recall/F1 for every class. W&B also receives a confusion matrix, a
ROC curve, and a precision-recall curve. These visualizations use the class
names declared by the selected dataset (for example ``ham`` and ``spam`` for
Enron Spam); datasets without names use stable labels such as ``class_0``.

The report is emitted once after testing, so the scalar charts show one point
at the final training step. Regression and autoencoder tasks do not collect
classification predictions or emit these charts.

Install and use an exported model
---------------------------------

Before submitting a job, optionally set **Nome pacchetto** in the training
sidebar. Enter only the suffix, for example ``mnist_classifier``: NNModelling
creates the distribution and Python module ``nnm_mnist_classifier``. The name
must begin with a letter and may then contain only letters, digits, and
underscores. When a job completes successfully, select **Scarica wheel** in
the job row and install the downloaded file in a Python 3.12+ environment:

.. code-block:: bash

   pip install ./nnm_mnist_classifier-0.1.0-py3-none-any.whl

The file is offered only after the download is verified twice. The backend
records the wheel's SHA-256 digest when it builds the package. At download
time it opens the wheel once, copies it into a private immutable snapshot
while hashing it, refuses to serve bytes whose snapshot digest no longer
matches the recorded digest, and returns the verified digest in the
``X-NNM-SHA256`` response header. Only the verified snapshot is ever
transferred, and it is deleted after the response ends. The browser already
holds the same digest in the authenticated job state; it checks that the
header is present, well-formed, and equal to that digest, then digests the
downloaded bytes itself before offering the file. This second check needs Web
Crypto, so the frontend must run in a secure context (HTTPS or localhost);
the backend itself may remain on HTTP when that context and CORS allow it.
A missing, malformed, or mismatched digest on either side cancels the
download without saving a file.

The wheel contains the resolved graph, safe ``safetensors`` weights and its
declared input adapter. It does not need the training backend, W&B, Lightning
or the training dataset. Every model offers a universal tensor API:

.. code-block:: python

   import torch
   from nnm_mnist_classifier import load_model

   model = load_model(device="cpu")
   logits = model.predict_tensor(batch_tensor)

``predict_tensor`` expects a batch tensor already prepared for the model. A
model trained with MNIST also offers ``model.predict(path_or_bytes_or_image)``;
it applies the saved grayscale, resize and normalization configuration before
inference. A model trained with ``EnronSpamDataset`` also accepts one raw email
string through ``model.predict(email_text)``. Its exported text adapter uses the
saved Hugging Face tokenizer name and maximum length. The first inference may
download that tokenizer unless it is already available in the local Hugging
Face cache; install the wheel's ``transformers`` dependency and provision the
tokenizer cache in offline environments.

Wheel download troubleshooting
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

If verification fails, the sidebar shows a message instead of saving a file.
A header that is missing, malformed, or different from the job manifest, or a
body whose digest does not match, is usually transient: retry the download,
or retrain the job if it keeps failing. A ``409`` ``package_integrity_error``
means the server itself refused to serve the wheel because the bytes no
longer match the recorded digest — contact the backend administrator. A
``package_verification_unavailable`` error means the frontend page is not a
secure context (HTTPS or localhost): open the frontend accordingly and retry;
it is not a backend or CORS problem. Jobs whose packaging failed (for example
because safe weights are missing or corrupt) end as ``failed`` and offer no
download at all.

Dataset class metadata
-----------------------

The training backend discovers the dataset classes installed in its trusted
environment. A dataset can declare its fixed classification cardinality through
the ``Dataset.num_classes(config)`` class method, without constructing or
downloading the dataset. The training sidebar displays this value and includes
it in the job request. The backend independently resolves the same metadata,
so requests from older clients are still correct. For example, MNIST declares
10 classes and Enron Spam declares 2. A supplied ``training.num_classes`` that
conflicts with a dataset's declared value is rejected before conversion.

Only the browser connection that created a job can download its wheel. The
wheel contains model parameters: store and distribute it as a model artifact,
not as a public URL.

Job privacy
-----------

Each job is assigned to the connection that submitted it. A browser can list,
inspect, stream, read logs for, and cancel only its own jobs. Attempting to
address another connection's job returns ``404`` without confirming that the
job exists.

The backend administrator can manage every job from the backend machine. Jobs
created by older NNModelling versions have no owner and are visible only to the
administrator.

Disconnect or revoke
--------------------

The sidebar offers two different actions:

``Dimentica su questo browser``
   Deletes the local URL and token. The backend connection remains valid until
   expiry or administrator revocation. Use this only when you intentionally
   want to remove local state without affecting another tab sharing it.

``Disconnetti e revoca``
   Revokes the connection immediately on the backend and then clears local
   state. Other tabs using the same browser storage lose access as well.

Common connection errors
------------------------

Backend unreachable or CORS Origin not authorized
   Confirm the URL and network route. If ``GET /health`` works outside the
   browser, ask the administrator to add the frontend's exact Origin to
   ``NNM_ALLOWED_ORIGINS`` and restart the backend.

Connection pending
   The administrator has not yet approved the displayed request. Compare the
   verification code before approval.

Session expired
   Request a renewal. Existing owned jobs return after approval.

Session revoked
   Pair again as a new connection or contact the administrator. Revocation is
   immediate and cannot be reversed from the old token.

No jobs are shown
   Job lists are intentionally scoped to the current connection. Jobs from a
   previous revoked or forgotten identity are not transferred automatically.

Security limitations
--------------------

Pairing prevents anonymous access and isolates job ownership, but an approved
browser is still trusted to submit training configuration. The current Hydra
configuration surface remains broad; server-side allowlists for all Hydra
targets and overrides are a separate hardening task.

The MCP server's remote-training HTTP client can use a protected backend when
the operator provisions a token externally, for example through the
``NNM_BACKEND_TOKEN`` environment variable: it sends the same ``Bearer``
header as the browser client on REST and authenticated SSE requests. It does
not perform browser pairing or token renewal itself — token provisioning and
rotation are an operator responsibility. Browser diagram tools are unaffected.
