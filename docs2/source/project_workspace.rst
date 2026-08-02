Project workspace
=================

NNModelling works on **projects**: self-contained directories holding the
diagram, its Python source, dataset definitions, stereotypes, a reproducible
``uv`` environment, and training runs. The companion (the FastAPI process) owns
project lifecycle, environment synchronization, and run storage; the browser
remains the live diagram authority.

Project layout
--------------

A project scaffold is created by the editor (or the companion API) and looks
like:

.. code-block:: text

   my-project/
   ├── pyproject.toml      # uv project depending on the NNModelling package
   ├── uv.lock             # reproducible lock (created by uv sync)
   ├── nnmodelling.toml    # versioned project metadata (no secrets)
   ├── model/
   │   └── graph.json      # the saved diagram (NNTree-compatible source)
   ├── stereotypes/        # project-local stereotype JSON (validated at open)
   ├── src/                # project-local Python targets for training jobs
   ├── assets/             # project assets
   ├── datasets/           # project-local dataset classes (Dataset subclasses)
   └── runs/               # job artifacts for project-scoped training

The companion state directory (platform user-data location, overridable with
``NNM_STATE_DIR``) keeps two files:

* ``projects.json`` — normalized project roots ordered by last-opened time plus
  the active project;
* ``secrets.json`` — W&B API keys per project, written with mode ``0600`` and
  never returned by any API read.

Create, open, recent, and restore
---------------------------------

* **Create** scaffolds the complete layout above. A non-empty directory that is
  not a valid project is never overwritten (the request fails with an
  actionable message).
* **Open** loads an existing valid project by path and validates its
  ``nnmodelling.toml`` metadata; invalid metadata is reported without replacing
  the current diagram.
* **Recent** projects persist in ``projects.json``; the last active project is
  restored automatically on editor startup, otherwise the project chooser is
  shown.

Local environments
------------------

Opening or creating a project drives ``uv sync --project <root>`` automatically,
creating ``<root>/.venv`` with the NNModelling package and its dependencies.
The environment state is surfaced in the editor (ready / missing / error), and
project-scoped training jobs execute with the **project interpreter** and its
own ``src/`` and ``datasets/`` import roots. A job fails clearly when the
project environment is unavailable — it never silently falls back to the
companion interpreter.

Project stereotypes, Python, and datasets
-----------------------------------------

* **Stereotypes**: the companion returns built-in plus project-local stereotype
  JSON from ``stereotypes/``. Malformed definitions are diagnosed without
  taking down the companion; project names that collide with built-ins are
  rejected explicitly.
* **Datasets**: project-local classes under ``datasets/`` are discovered
  alongside the built-ins. Only subclasses of the canonical
  ``dataset.ds.Dataset`` base are accepted; invalid classes are reported.
* **Python targets**: project ``src/`` is importable during training runs.

W&B configuration and secrets
-----------------------------

Per-project W&B settings — entity, project, tags, run-name template, and mode —
live in ``nnmodelling.toml`` as non-secret defaults; the editor may override the
non-secret fields per job. The **W&B API key is stored separately** in the
companion state file with owner-only permissions. It is absent from project
files, API reads, logs, exports, and job configs, and is injected only into the
child training process environment.

Runs
----

Project-scoped jobs write their artifacts under ``<project>/runs/<job-id>/``
(logs, Hydra config, safe weights, and the exported wheel). Jobs submitted
without a project keep the legacy backend behavior and artifact location.
Ownership, cancellation, integrity, Slurm, and SSE contracts are unchanged.

Start locally
-------------

One command installs and starts NNModelling — it fetches the repository (or
updates an existing checkout), installs the pnpm dependencies, builds the
editor, ensures a local Valkey is running, and then starts the companion:

.. code-block:: bash

   curl -fsSL https://lucasforza.github.io/NNModelling/install.sh | bash

The installer checks for (it never installs) Git, Python 3.12+ with ``uv``,
Node.js 18+ with pnpm, and Valkey 8. It reuses a healthy Valkey instance or
starts a repository-local ``valkey-server`` process, stops only that process
when the companion exits, refuses to overwrite a destination that is not an
NNModelling checkout, and never prints secrets. Configure the checkout with
``NNM_DEST_DIR`` (default ``$HOME/.local/share/nnmodelling``), ``NNM_BRANCH``,
and ``NNM_REMOTE_REPO``, and the companion bind settings with
``NNM_BACKEND_HOST``/``NNM_BACKEND_PORT`` or the Valkey connection with
``NNM_VALKEY_URL``/``NNM_VALKEY_PORT``.

Developers who already have a checkout run the same steps by hand instead:

.. code-block:: bash

   pnpm install && pnpm --dir front-end build
   just --justfile converted/backend/justfile valkey   # optional: Valkey running
   PYTHONPATH=converted/src uv run --project converted python -m backend.cli

Open ``http://127.0.0.1:8000``. The command fails actionably when the frontend
assets are missing (with a build instruction) or Valkey is unreachable; it never
serves an empty UI. On first start it provisions the local administrator token
automatically (mode ``0600``, honoring ``NNM_ADMIN_TOKEN_FILE``), so pairing
needs no separate ``admin-init`` step. The editor calls project APIs on the
same origin under the ``/api`` prefix, and the Training Sidebar pairs with the
same process at its default ``http://127.0.0.1:8000`` URL.

Localhost or a remote backend
-----------------------------

The Training Sidebar keeps its URL and pairing workflow unchanged: enter
``http://127.0.0.1:8000`` to train on this machine through the companion, or any
remote backend URL (for example ``http://192.168.1.20:8000``) to train on a
server or Slurm cluster. The companion does **not** proxy, route, or duplicate
training jobs — selecting local versus remote is simply which backend URL the
sidebar is connected to.
