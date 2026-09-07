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
