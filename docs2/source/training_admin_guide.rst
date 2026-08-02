Training backend administrator guide
====================================

This guide installs and operates the authenticated NNModelling training
backend on one workstation or on a Slurm cluster. The administrator approves
browser connections and can inspect, cancel, or revoke all backend state with
``just`` commands executed on the backend machine.

.. warning::

   This release supports a trusted LAN only. Do not publish FastAPI, Valkey,
   or the administrator token on the Internet. Restrict port 8000 to the LAN,
   keep Valkey on loopback/private service networking, and prefer HTTPS.

Architecture and trust boundary
-------------------------------

.. code-block:: text

   approved browser -- REST + authenticated SSE --> FastAPI
                                                    |      |
                                                    |      +-> local Python
                                                    |      +-> Slurm sbatch
                                                    v
                                                  Valkey

FastAPI owns authentication, job ownership, queueing, and live executor
handles. Valkey persists session, queue, job, and event metadata. Job configs,
logs, checkpoints, and results live under ``NNM_BACKEND_ARTIFACT_ROOT``.

The administrator capability is a random machine-local secret, not a user
password. It is stored in ``converted/valkey-data/admin.token`` by default,
with mode ``0600``. ``just`` reads it and sends it in an administrator-only
header; commands never print the secret.

Install on a workstation or server
----------------------------------

Prerequisites
~~~~~~~~~~~~~

Install Git, Python 3.12, `uv <https://docs.astral.sh/uv/>`_,
`just <https://just.systems/>`_, and Valkey 8. Clone the repository, then
install the Python environment:

.. code-block:: bash

   git clone <NNModelling repository URL>
   cd NNModelling/converted
   uv sync
   cd ..

All following examples run from the repository root and explicitly select the
backend justfile.

Local companion: editor + backend in one command
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

For a single-user workstation, the bundled installer fetches, builds, and
starts the companion in one command:

.. code-block:: bash

   curl -fsSL https://lucasforza.github.io/NNModelling/install.sh | bash

It checks for (never installs) Git, Python 3.12+ with ``uv``, Node.js 18+ with
pnpm, and Valkey 8; it reuses a healthy Valkey instance or starts a
repository-local ``valkey-server`` process (stopping only that process when the
companion exits), refuses to overwrite a destination that is not an NNModelling
checkout, and never prints secrets. Set ``NNM_DEST_DIR``/``NNM_BRANCH``/
``NNM_REMOTE_REPO`` to control the checkout.

On an existing checkout, run the same steps by hand:

.. code-block:: bash

   pnpm --dir front-end build
   PYTHONPATH=converted/src uv run --project converted python -m backend.cli

Open ``http://127.0.0.1:8000``. The command fails actionably when
``front-end/dist`` is missing (with a build instruction) or Valkey is
unreachable; it never serves an empty UI. On first start it provisions the
local administrator token automatically (mode ``0600``, honoring
``NNM_ADMIN_TOKEN_FILE``), so the ``backend`` recipe's separate ``admin-init``
step is not needed when using the companion command. The editor's project
calls resolve under the ``/api`` prefix on the same origin, while the root
training routes (``/health``, ``/pairing``, ``/jobs``) remain available to the
Training Sidebar. For LAN clients, bind with ``--host 0.0.0.0`` and set
``NNM_ALLOWED_ORIGINS`` exactly as described under *Start FastAPI* below.

The companion does not proxy remote jobs: remote/Slurm training still connects
the Training Sidebar directly to this or another backend URL.

Start Valkey
~~~~~~~~~~~~

In the first terminal:

.. code-block:: bash

   just --justfile converted/backend/justfile valkey

The recipe stores persistent data in ``converted/valkey-data`` and keeps
Valkey on its configured local interface. Never forward port 6379 to the LAN.

Start FastAPI
~~~~~~~~~~~~~

For access only from the same PC:

.. code-block:: bash

   just --justfile converted/backend/justfile backend

For LAN clients, bind FastAPI to all interfaces and declare every permitted
frontend Origin exactly:

.. code-block:: bash

   NNM_BACKEND_HOST=0.0.0.0 \
   NNM_ALLOWED_ORIGINS=http://192.168.1.30:5174,http://nn-editor.lan \
   just --justfile converted/backend/justfile backend

The ``backend`` recipe runs ``admin-init`` first. Confirm health from an
allowed LAN host:

.. code-block:: bash

   curl http://192.168.1.20:8000/health

Allow TCP port 8000 only from the intended subnet in the host firewall. CORS
is a browser control, not a replacement for the firewall or bearer token.

Docker Compose installation
~~~~~~~~~~~~~~~~~~~~~~~~~~~

The Compose deployment provides persistent Valkey and job volumes. From the
repository root:

.. code-block:: bash

   just --justfile converted/backend/justfile docker-up

The recipe creates the host administrator token before Compose mounts it
read-only at ``/run/secrets/nnm-admin-token``. Set ``NNM_ALLOWED_ORIGINS`` in
the Compose environment before admitting LAN browsers. Stop services without
deleting volumes with:

.. code-block:: bash

   just --justfile converted/backend/justfile docker-down

Approve and revoke browser connections
--------------------------------------

List pending requests and compare the displayed code with the user's browser:

.. code-block:: bash

   just --justfile converted/backend/justfile pairing-pending

Approve with the global default lifetime (24 hours unless configured):

.. code-block:: bash

   just --justfile converted/backend/justfile pairing-approve REQUEST_ID

Override the lifetime for this approval only:

.. code-block:: bash

   just --justfile converted/backend/justfile pairing-approve REQUEST_ID 8h
   just --justfile converted/backend/justfile pairing-approve REQUEST_ID 7d

Reject a request, list all sessions, or revoke one immediately:

.. code-block:: bash

   just --justfile converted/backend/justfile pairing-reject REQUEST_ID
   just --justfile converted/backend/justfile sessions
   just --justfile converted/backend/justfile session-revoke CONNECTION_ID

Approve only requests whose verification code and device context you can
confirm. Device name, IP, Origin, and user-agent are descriptive metadata and
are not authentication factors.

Administer jobs
---------------

Administrator commands are not scoped by browser ownership:

.. code-block:: bash

   just --justfile converted/backend/justfile admin-jobs
   just --justfile converted/backend/justfile admin-job JOB_ID
   just --justfile converted/backend/justfile admin-job-logs JOB_ID
   just --justfile converted/backend/justfile admin-job-cancel JOB_ID

Cancellation is sent through the running FastAPI process. Do not edit a job's
Valkey status manually: a separate process does not own the local/Slurm
executor handle and could leave the actual training process running.

Model wheel artifacts
---------------------

The portable wheel is a required output of every successful job. After the
training process writes ``weights.safetensors``, the backend builds
``dist/nnm_<chosen_name>-0.1.0-py3-none-any.whl`` inside the job artifact
directory and records ``model-package.json`` with the wheel's SHA-256. The
browser may choose only the suffix; the backend requires the full name to
match ``nnm_<name>`` and falls back to ``nnm_job_<job_id>`` when none is sent.

Download verification
~~~~~~~~~~~~~~~~~~~~~

The browser owner downloads the wheel through ``GET /jobs/{job_id}/package``;
the endpoint does not accept a filesystem path and applies normal job
ownership. Before serving a single byte, the backend opens the wheel once,
copies it into a private immutable snapshot (``0600``, never exposed through
an API path) while computing its SHA-256, and compares that digest in
constant time against the digest recorded in ``model-package.json`` at export
time. Only the verified snapshot is served — never the mutable artifact path
— so bytes replaced on disk after verification cannot be transferred. A
manifest whose digest is missing or malformed, or a snapshot whose bytes no
longer match it, is rejected with ``409 Conflict`` and ``{"code":
"package_integrity_error"}``; the artifact is never served and the response
never reveals filesystem paths. The snapshot is removed after the response
completes, errors, or is disconnected. On success the verified digest is
exposed through the ``X-NNM-SHA256`` response header, which CORS explicitly
allows browsers to read.

Packaging failures are terminal
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

There is no legacy fallback for jobs without safe weights: the wheel is part
of the promised output of a successful job, so a missing or corrupt
``weights.safetensors`` (a file that cannot be opened as a safetensors
container, or an empty container), an unsupported dataset adapter, or any
exporter exception is a packaging failure. The job records a client-visible
``package_error``, emits a ``package_failed`` event, and then transitions to
the terminal ``failed`` state through the same atomic failed transition as any
other failure. The error, lifecycle events, and training logs remain visible
to the owning browser and to ``just`` administrator commands, and the artifact
root is kept. The job is never reported successful before its wheel committed:
on the happy path the events are ordered ``package_ready`` then ``succeeded``.
A job that failed packaging has no manifest, so its download returns ``404``.

Diagnosis
~~~~~~~~~

* A ``409`` ``package_integrity_error`` on download means the wheel on disk no
  longer matches the digest recorded at export time. Check the artifact root
  for disk corruption or a partial backup restore, and consider restoring the
  wheel (and ``model-package.json``) as one pair.
* A job ending as ``failed`` with a ``package_error`` after training finished
  points at packaging, not training. Inspect ``weights.safetensors`` in the
  job artifact directory: it must exist, parse as a safetensors container, and
  contain at least one tensor. Verify that ``resolved_config.yaml`` (or
  ``resolved_config.json``) is valid and that the dataset adapter is supported
  by the exporter.
* Keep the artifact root persistent and include wheels in backup/retention
  policies: they are the portable form of trained models, and a wheel can be
  re-downloaded only while its manifest and bytes remain consistent.

Configuration reference
-----------------------

.. list-table::
   :header-rows: 1
   :widths: 34 23 43

   * - Variable
     - Default
     - Purpose
   * - ``NNM_BACKEND_HOST``
     - ``127.0.0.1``
     - Uvicorn bind address used by the justfile
   * - ``NNM_BACKEND_PORT``
     - ``8000``
     - FastAPI port
   * - ``NNM_VALKEY_URL``
     - local Valkey database 0
     - Persistent control-plane connection
   * - ``NNM_BACKEND_ARTIFACT_ROOT``
     - ``converted/jobs``
     - Config, log, checkpoint, and result directory
   * - ``NNM_ALLOWED_ORIGINS``
     - local Vite Origins
     - Comma-separated exact browser Origins
   * - ``NNM_SESSION_TTL``
     - ``24h``
     - Default approved connection lifetime
   * - ``NNM_PAIRING_REQUEST_TTL``
     - ``10m``
     - Pending request lifetime
   * - ``NNM_PAIRING_MAX_PER_IP``
     - ``5``
     - Maximum concurrent pending requests from one IP
   * - ``NNM_PAIRING_MAX_GLOBAL``
     - ``100``
     - Maximum concurrent pending requests
   * - ``NNM_ADMIN_TOKEN_FILE``
     - ``converted/valkey-data/admin.token``
     - Machine-local administrator capability

Durations use ``m``, ``h``, or ``d`` and must be positive, for example
``30m``, ``24h``, or ``7d``. The maximum accepted session lifetime is 365
days.

Install on a Slurm cluster
--------------------------

The backend can run on a cluster login/service node and call ``sbatch``
locally, or run on another LAN server and submit through SSH. Start with local
``sbatch`` when possible: it has fewer filesystem and credential assumptions.

Cluster prerequisites
~~~~~~~~~~~~~~~~~~~~~

1. Choose a service/login node allowed to run FastAPI, Valkey, ``sbatch``,
   ``squeue``, ``sacct``, and ``scancel`` according to site policy.
2. Install the repository and ``uv sync`` on a filesystem visible to every
   compute node.
3. Put ``NNM_BACKEND_ARTIFACT_ROOT`` on the same shared filesystem. Compute
   nodes must see the artifact path under the identical absolute path.
4. Ensure ``python`` in the submitted environment resolves to the NNModelling
   environment and can import PyTorch, Lightning, Hydra, datasets, and the
   project. Slurm normally exports the submission environment, but verify this
   on your cluster.
5. Ensure accounting is enabled if completion must fall back from ``squeue``
   to ``sacct``.

Example: backend on a Slurm login/service node
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Assume the repository is installed at ``/shared/nnmodelling/converted`` and
artifacts belong in ``/shared/nnmodelling/jobs``:

.. code-block:: bash

   cd /shared/nnmodelling/NNModelling
   source converted/.venv/bin/activate

   # Terminal 1
   just --justfile converted/backend/justfile valkey

   # Terminal 2
   NNM_BACKEND_HOST=0.0.0.0 \
   NNM_ALLOWED_ORIGINS=http://editor.lan:5174 \
   NNM_BACKEND_ARTIFACT_ROOT=/shared/nnmodelling/jobs \
   NNM_ENABLE_SLURM=1 \
   NNM_SLURM_UNIT_ID=slurm-gpu \
   NNM_SLURM_PROJECT_DIR=/shared/nnmodelling/NNModelling/converted \
   NNM_SLURM_PARTITION=gpu \
   NNM_SLURM_ACCOUNT=my-project \
   NNM_SLURM_CPU=32 \
   NNM_SLURM_MEMORY_GB=128 \
   NNM_SLURM_GPU=2 \
   NNM_SLURM_GPU_TYPE=A100 \
   just --justfile converted/backend/justfile backend

``NNM_SLURM_CPU``, memory, GPU count, and GPU type describe the maximum request
accepted by this executor profile. Each browser job still supplies its own
request within that capacity. ``NNM_SLURM_PARTITION`` and account are
administrator-controlled and become ``#SBATCH`` directives.

Example: submit to Slurm over SSH
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

SSH mode invokes ``ssh HOST sbatch``, ``squeue``, ``sacct``, and ``scancel``
without an interactive shell. Configure a restricted service account and
non-interactive SSH key first:

.. code-block:: bash

   ssh slurm-submit sbatch --version
   ssh slurm-submit squeue --version
   ssh slurm-submit sacct --version

Then add these variables to the backend command:

.. code-block:: bash

   NNM_ENABLE_SLURM=1 \
   NNM_SLURM_SSH_HOST=slurm-submit \
   NNM_SLURM_PROJECT_DIR=/shared/nnmodelling/NNModelling/converted \
   NNM_BACKEND_ARTIFACT_ROOT=/shared/nnmodelling/jobs \
   just --justfile converted/backend/justfile backend

SSH transports the batch script only. It does not copy the repository,
generated Hydra configuration, logs, or checkpoints. The backend host must
mount the cluster shared filesystem at the same absolute paths used on compute
nodes; otherwise jobs will be submitted but fail to find their config.

Slurm smoke test
~~~~~~~~~~~~~~~~

1. Pair a browser and approve it.
2. Submit a one-epoch CPU or small GPU job from the frontend.
3. Run ``just ... admin-jobs`` and note the job ID and Slurm executor.
4. Confirm the Slurm ID with ``squeue`` and inspect
   ``JOB_ARTIFACT_DIR/batch.sh``.
5. Verify terminal status, ``stdout.log``, ``stderr.log``, and checkpoint files.
6. Submit a second job and test ``just ... admin-job-cancel JOB_ID``; confirm
   that ``scancel`` removes it.

Operations, backup, and recovery
--------------------------------

Back up both Valkey persistence files and the artifact root. They form one
logical state: Valkey records point to filesystem artifacts. Preserve the
administrator token separately with mode ``0600``.

To rotate the administrator capability, stop FastAPI, move the old file to a
protected backup, run ``just ... admin-init``, then restart FastAPI. Existing
browser tokens are unaffected. Restore the backup if local admin commands must
temporarily access a backend process still using the old capability.

On graceful shutdown the backend stops scheduling and cancels executions it
owns. A running job found after an unclean restart is marked failed because the
new process cannot prove it still owns the original executor handle.

Security and current limitations
--------------------------------

* Pairing and ownership protect the HTTP API, but approved clients can still
  submit a broad Hydra configuration. Target/override allowlisting remains a
  separate hardening requirement.
* Local resource values are scheduling compatibility metadata; they do not
  create cgroup or container isolation.
* The initial scheduler runs one job at a time.
* The MCP remote-training HTTP client can use this protected backend when the
  operator provisions a token externally (``NNM_BACKEND_TOKEN`` or an explicit
  client token). It sends the same ``Bearer`` header as the browser client but
  does not perform pairing or renewal itself: provisioning and rotation of the
  MCP token are an operator responsibility.
* Never expose the administrator token, its file, Valkey, or artifact paths
  through a web server.

Verification and upgrades
-------------------------

Run the maintained checks before deploying an upgrade:

.. code-block:: bash

   just --justfile converted/backend/justfile test
   pnpm --dir front-end test
   pnpm --dir front-end check
   cd docs2 && uv run make html

Jobs created before ownership support are retained as legacy unowned jobs.
Browsers cannot see them; the administrator can list and manage them with the
normal admin job commands.
