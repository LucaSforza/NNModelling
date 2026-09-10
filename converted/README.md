# NNModelling package backend

This directory contains the Python runtime and authenticated backend for the
package format. The browser creates a signed package bundle; FastAPI validates
it and schedules a worker container. FastAPI never imports or executes package
code.

## Backend

```bash
PYTHONPATH=src uv run python -m backend.cli --host 127.0.0.1 --port 8000
```

Dataset archives default to a 64 MiB compressed limit, 16 MiB per file,
64 MiB total uncompressed, and 2048 files. A finite CLI override applies the
same value to all three byte limits, so it also permits individual files such
as a large `train.jsonl`:

```bash
PYTHONPATH=src uv run python -m backend.cli --max-dataset-size 256MiB
```

Sizes accept positive integer values suffixed with `B`, `KiB`, `MiB`, or
`GiB`. The legacy `NNM_DATASET_MAX_ARCHIVE_BYTES` environment variable remains
supported as a positive byte count and changes only the compressed archive
limit. An explicit CLI size takes precedence over that environment variable.

The explicitly dangerous mode below disables the compressed, per-file, and
total-uncompressed byte limits. It does not disable the 2048-file limit, path
and ZIP safety checks, metadata validation, ownership, digest verification, or
atomic publication. It is named unsafe because an upload can consume
unbounded memory, disk, and decompression resources.

```bash
PYTHONPATH=src uv run python -m backend.cli --unsafe-unlimited-dataset-size
# or, from the repository root:
just --justfile converted/backend/justfile backend-unsafe-unlimited-dataset-size
```

`--max-dataset-size` and `--unsafe-unlimited-dataset-size` are mutually
exclusive. The capabilities endpoint reports the compressed upload limit as a
number in finite mode and `max_bytes: null` in unsafe unlimited mode.

Submit a `package-bundle/v1` through the package-bundles endpoint, then submit
a typed `network.format="package"` training request. Jobs are executed by the
configured Podman or Docker container controller and expose status, logs,
events, cancellation and the portable model wheel through the API.

## Package worker image

The worker is an immutable container image. Rebuild it whenever a change affects
code or dependencies executed in the worker, then restart FastAPI with the
printed digest. Restarting FastAPI alone keeps using its previous worker image.

```bash
just --justfile converted/backend/justfile worker-build
# Copy the printed NNM_CONTAINER_IMAGE=...@sha256:... value into the backend launch.
```

Pass an optional local tag when keeping multiple development images:

```bash
just --justfile converted/backend/justfile worker-build classification-metrics
```

The tag is only a local build label. Always configure FastAPI with the printed
digest reference, never the tag.

## Weights & Biases administration

W&B uses one backend-administrator-owned account. Connect it from the repository
root; the command prompts for the API key and never accepts it in argv:

```bash
just --justfile converted/backend/justfile wandb-connect <entity>
# Self-hosted deployment:
just --justfile converted/backend/justfile wandb-connect <entity> https://wandb.example.org

just --justfile converted/backend/justfile wandb-status
just --justfile converted/backend/justfile wandb-disconnect
```

`wandb-connect` verifies the account before atomically writing
`converted/backend-secrets/wandb-credentials.json` with mode `0600`.
`wandb-status` prints only the schema version, entity and base URL. Override the
machine-local path with `NNM_WANDB_CREDENTIAL_FILE` when required.

Disabled and offline jobs remain on `--network none` and never receive the
credential. To advertise online mode, start the trusted controller with all
three operator settings:

```bash
NNM_WANDB_CREDENTIAL_FILE=/secure/path/wandb-credentials.json \
NNM_WANDB_NETWORK=nnm-wandb-egress \
NNM_WANDB_PROXY_URL=http://wandb-proxy.internal:3128 \
just --justfile converted/backend/justfile controller
```

The named container network must be configured outside NNModelling to deny
direct egress and allow only the proxy; the proxy must allowlist the selected
W&B Cloud or self-hosted endpoint. Proxy URLs containing credentials are
rejected. The browser cannot select the entity, base URL, proxy or network.
Online submissions are rejected before queueing when this capability is
incomplete, and an online SDK error fails the job without changing mode.

Browser users select a W&B project and mode. `Online (consigliato)` exposes the
structured run link. Offline creates a real W&B run under the job artifacts and
offers an authenticated ZIP whose SHA-256 digest is verified before download.
NNModelling does not upload the dataset, weights or model wheel as W&B
Artifacts.

## Runtime contract

Package definitions provide the graph, resources and PyTorch builders. The
compiler creates a prediction program and an objective program over one shared
parameter store. Dataset adapters provide `(inputs, targets)` batches to the
objective program; prediction wheels expose inference without training-only
targets.

The portable wheel contains the package graph, required package resources,
input adapter metadata and `safetensors` weights. It can be installed without
the NNModelling checkout or the historical configuration stack.

## Tests

```bash
uv run pytest src/tests/ -m fast -q
```

Backend service, worker-container and real dataset checks are separate test
tiers and should be run when the changed behavior crosses those boundaries.
