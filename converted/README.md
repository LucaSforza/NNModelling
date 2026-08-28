# NNModelling package backend

This directory contains the Python runtime and authenticated backend for the
package format. The browser creates a signed package bundle; FastAPI validates
it and schedules a worker container. FastAPI never imports or executes package
code.

## Backend

```bash
uv run uvicorn src.backend.app:app --host 127.0.0.1 --port 8000
```

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
