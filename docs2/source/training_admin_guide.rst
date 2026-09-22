Operate a training backend
==========================

A training deployment needs FastAPI, persistent Valkey, a trusted container
controller and a digest-pinned worker image. FastAPI validates and stores
uploads; each job executes package and dataset Python inside a separate
Podman/Docker worker. Only the controller needs access to the container engine
socket.

Commands below run from the repository root unless stated otherwise. The
checked-in ``converted/backend/justfile`` is the command reference; use
``just --justfile converted/backend/justfile --list`` to inspect its recipes.

Local foreground deployment
---------------------------

Install the Python environment with ``cd converted && uv sync``. The local
recipes also require ``just``, Valkey and a working rootless Podman engine.
Start long-running components in separate terminals:

1. Start persistent Valkey:

   .. code-block:: console

      $ just --justfile converted/backend/justfile valkey

2. Build the worker from this checkout:

   .. code-block:: console

      $ just --justfile converted/backend/justfile worker-build

   Keep the printed ``NNM_CONTAINER_IMAGE=...@sha256:...`` reference. The
   mutable local build tag is not a supported worker image reference.

3. Start the controller:

   .. code-block:: console

      $ just --justfile converted/backend/justfile controller

4. Export the printed image reference in the backend terminal, then start
   FastAPI with the editor origins you intend to permit:

   .. code-block:: console

      $ export NNM_CONTAINER_IMAGE='localhost/nnm-worker@sha256:<printed-digest>'
      $ NNM_ALLOWED_ORIGINS=http://127.0.0.1:5174,http://localhost:5174,app://nnmodelling \
          just --justfile converted/backend/justfile backend

   Replace ``<printed-digest>`` with the worker build's actual digest. The
   default API address is ``http://127.0.0.1:8000``. Remove origins you do not
   use, and add the exact origin if your frontend uses another port.

5. Verify reachability:

   .. code-block:: console

      $ just --justfile converted/backend/justfile health

A successful health response alone does not prove worker readiness. Confirm
controller access to the engine and the configured image before submitting a
representative job. After changing worker code or dependencies, rebuild the
image and restart FastAPI with the new digest.

Persistent Compose deployment
-----------------------------

The standard local Podman recipe builds the worker, starts the user Podman
socket and launches Valkey, controller and backend:

.. code-block:: console

   $ just --justfile converted/backend/justfile compose

.. warning::

   The standard Compose service starts with
   ``--unsafe-unlimited-dataset-size``. It disables dataset byte limits and can
   exhaust host resources. Use a bounded configuration for an untrusted or
   resource-constrained host; do not assume the foreground defaults apply.

Persistent jobs, data, Valkey state and owner-only secret files use host paths
under ``converted/``. Preserve those paths when replacing containers. The
controller alone receives the host engine socket; FastAPI uses the authenticated
controller socket instead.

For custom paths, origins, resource limits or engine settings, inspect and
configure ``converted/backend/docker-compose.yml`` explicitly rather than
assuming the convenience recipe covers them. Docker deployments need matching
engine and socket configuration.

Approve browser connections
---------------------------

The user selects **Request connection** in the Training sidebar. On the backend
machine:

.. code-block:: console

   $ just --justfile converted/backend/justfile pairing-pending
   $ just --justfile converted/backend/justfile pairing-approve REQUEST_ID 8h

Compare the request's device name, origin and verification code with the user's
sidebar before approving its actual request ID. The code is a human comparison
check, not a password to enter in another browser form.

Use ``sessions`` to inspect approved connections and
``session-revoke CONNECTION_ID`` to revoke one. An approved renewal preserves
connection ownership; creating a new pairing does not transfer old jobs or
dataset permissions.

Administrator and controller token files are local capabilities. The recipes
create them under ``converted/backend-secrets/``. Do not paste tokens into
commands, browser fields, logs or project files. Keep Valkey private. The
plain-HTTP configuration is intended for localhost or a trusted LAN, not direct
Internet exposure.

Dataset limits
--------------

Project datasets are uploaded as complete archives. Default limits are:

.. list-table::
   :header-rows: 1
   :widths: 60 40

   * - Limit
     - Default
   * - Compressed archive
     - 64 MiB
   * - Individual expanded file
     - 16 MiB
   * - Total expanded content
     - 64 MiB
   * - Archive members
     - 2048

The backend CLI accepts ``--max-dataset-size SIZE`` with a positive ``B``,
``KiB``, ``MiB`` or ``GiB`` value. It sets all three byte limits to the same
value. For a configured foreground environment, inspect its options from
``converted/``:

.. code-block:: console

   $ PYTHONPATH=src uv run python -m backend.cli --help

``NNM_DATASET_MAX_ARCHIVE_BYTES`` changes only the compressed limit; an explicit
CLI choice takes precedence. ``--unsafe-unlimited-dataset-size`` disables the
three byte caps, but retains the member limit, safe-path validation, metadata
checks, digests and ownership checks. The authenticated capabilities response
advertises the effective limit to clients.

W&B configuration
-----------------

Disabled and offline jobs receive no W&B credentials and no network access.
For online tracking, configure the shared account using the interactive prompt:

.. code-block:: console

   $ just --justfile converted/backend/justfile wandb-connect YOUR_ENTITY
   $ just --justfile converted/backend/justfile wandb-status

The controller also requires ``NNM_WANDB_NETWORK`` and ``NNM_WANDB_PROXY_URL``
for an operator-managed network and allowlisting proxy. These are separate
infrastructure dependencies; the standard Compose recipe does not create them.
The network must deny direct egress and allow only the proxy route.

The credential file is owner-only. Credentials reach the worker through stdin,
not engine arguments, job metadata or artifact files. An online submission is
rejected unless all required capabilities are configured. An online SDK failure
does not silently downgrade the job to offline mode.

Inspect jobs and artifacts
--------------------------

.. code-block:: console

   $ just --justfile converted/backend/justfile jobs
   $ just --justfile converted/backend/justfile admin-job JOB_ID
   $ just --justfile converted/backend/justfile admin-job-logs JOB_ID

Use ``admin-job-cancel JOB_ID`` only for a job you intend to stop. Valkey owns
queue state, heartbeats and recovery; do not infer completion from a container
exit or log line alone.

A successful job provides a training summary, safetensors weights and a portable
prediction wheel. Wheel download requires an owned job and
``packageName=nnm_<suffix>``; the response checksum covers the exact renamed
wheel bytes. Terminal offline W&B jobs expose a separate authenticated archive.
See :doc:`python_api` and :doc:`troubleshooting`.
