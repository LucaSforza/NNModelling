---
kind: historical-report
status: archived
archived: 2026-08-12
current_knowledge: ../../../knowledge/architecture/remote-training.md
---

# Remote training backend: implementation notes

This document records the implementation of the
[remote training design](../../completed-plans/remote-training-backend/initial-plan.md)
for issue #14. The first version deliberately schedules one job at a time, but
keeps the job, resource and executor contracts ready for additional workers.

## Components

The implementation is split as follows:

```text
front-end/                         Svelte training mode + REST/SSE client
converted/src/backend/             FastAPI, Hydra service, queue and executors
converted/backend/                 Valkey configuration and Docker deployment
mcp-server/src/remote-training.ts  thin HTTP client for MCP tools
```

The frontend and MCP server both call the same FastAPI API. MCP does not keep a
second queue or a copy of job state.

## Job contract

`POST /jobs` receives one JSON document containing the compiled network and all
training choices:

```json
{
  "schema_version": 1,
  "network": { "format": "nntree", "value": {} },
  "training": {
    "seed": 42,
    "dataset": "dataset.mnist.MNISTDataset",
    "optimizer": { "_target_": "torch.optim.Adam", "lr": 0.001 },
    "trainer": { "max_epochs": 20, "accelerator": "auto" },
    "wandb": { "project": "NeuralNetworks", "mode": "online" },
    "early_stopping": { "patience": 3, "min_delta": 0.0 },
    "overrides": ["trainer.max_epochs=10"]
  },
  "resources": {
    "cpu": 8,
    "memory_gb": 32,
    "gpu": 1,
    "gpu_memory_gb": 16,
    "gpu_type": "A100",
    "node": null
  },
  "priority": 50
}
```

The backend normalizes a dataset string to Hydra's `{ "_target_": "..." }`
form. A complete Hydra mapping is also accepted. `training.overrides` is
applied with Hydra/OmegaConf and never passed through a shell. The submitted
document is saved as `requested_config.json`; the composed result is saved as
`resolved_config.yaml`.

## Dataset discovery

`GET /datasets` imports the trusted `dataset` package installed with the
backend, finds concrete subclasses of `dataset.ds.Dataset`, and returns their
Python target, documentation and constructor parameters. This means a cluster
administrator can install a new dataset class and make it visible to the UI
without changing frontend code.

## Valkey model and scheduling

Valkey is used as the persistent control plane. The current implementation uses
the following keys:

```text
job:{id}                    JSON job metadata and submission reference
job:{id}:events             Valkey Stream of lifecycle events
queue:priorities            sorted set of priority values
queue:priority:{priority}   sorted set of job IDs, scored by creation time
```

The queue is claimed by one Lua operation: it selects the highest priority,
selects the oldest job at that priority, removes it, and removes an empty
priority bucket. This prevents duplicate claims when the scheduler is later
made concurrent. The ordering is priority first and FIFO second. Executor
selection advances a round-robin cursor across compatible compute units.

There is no lease model. Heartbeats are timestamps and diagnostic details in
the job metadata, emitted by local process monitoring or Slurm polling.

`converted/backend/valkey.conf` enables AOF (`appendonly yes`) with periodic RDB
snapshots. `docker-compose.yml` mounts both the Valkey data volume and the
backend artifact volume, so a restart retains queue state and job logs.

## Executors

`LocalExecutor` runs the repository's known `src/main.py` entry point, captures
`stdout.log` and `stderr.log`, reports process heartbeats and terminates the
process group on cancellation.

`SlurmExecutor` generates `batch.sh` from validated resource fields. It can
submit locally with `sbatch --parsable` or remotely by invoking
`ssh <host> sbatch --parsable` and sending the script on stdin. It polls
`squeue`/`sacct` and uses `scancel` for cancellation. Slurm output is directed
to the same `stdout.log` and `stderr.log` files exposed by the API.

The production Slurm profile is configured with:

```text
NNM_ENABLE_SLURM=1
NNM_SLURM_PARTITION=gpu
NNM_SLURM_ACCOUNT=project-name
NNM_SLURM_SSH_HOST=cluster             # omit for local sbatch
NNM_SLURM_PROJECT_DIR=/shared/NNModelling/converted
NNM_SLURM_CPU=32
NNM_SLURM_MEMORY_GB=128
NNM_SLURM_GPU=2
NNM_SLURM_GPU_TYPE=A100
```

The compute unit is currently a logical local or Slurm profile. A future
version can split a two-GPU Slurm node into two GPU units without changing the
job resource request. The initial manager still enforces
`max_running_jobs=1`.

## Frontend and MCP

The `TrainingSidebar.svelte` mode is separate from the node property sidebar.
It loads `/datasets`, renders dataset constructor fields, exposes common Hydra
sections, accepts arbitrary override lines, collects resources and priority,
and submits the current `Diagram` as an NNTree in the same JSON document.

Job state is refreshed through REST and lifecycle events through SSE. A W&B URL
printed by the training process is extracted into job metadata; the UI opens it
with `window.open(..., "_blank")`.

The `Carica` action accepts source Svelte Flow JSON files (with `nodes` and
`edges`), keeps its file input in the DOM while Chrome's picker is open, and
shows a visible error for malformed or pre-converted NNTree JSON. It does not
replace the current diagram when parsing fails. The direct Chrome validation
workflow captures a screenshot after a successful load; screenshots are kept
under `/tmp` unless a repository artifact is explicitly requested.

The MCP server exposes the following thin proxy tools:

```text
list_training_datasets
list_training_compute_units
submit_training_job
list_training_jobs
get_training_job
get_training_job_logs
get_training_job_events
cancel_training_job
```

## Running locally

From `converted/`, start persistent Valkey and the backend:

```bash
mkdir -p /tmp/nnmodelling-valkey
valkey-server backend/valkey.conf --dir /tmp/nnmodelling-valkey

PYTHONPATH=src NNM_VALKEY_URL=valkey://127.0.0.1:6379/0 \
  uv run uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

The frontend proxies `/api` to `http://127.0.0.1:8000`. Docker deployment is
available with:

```bash
cd converted/backend
docker compose up --build
```

For a source checkout or a backend installed directly on a machine, the
default artifact root is `converted/jobs/`; each job gets its own directory.
`NNM_BACKEND_ARTIFACT_ROOT` overrides this path for a mounted persistent
volume, Docker, or a shared Slurm filesystem. The earlier browser smoke test
used `/tmp/nnm-backend-jobs-8000` explicitly and therefore does not represent
the default installation layout.

## Portable model wheels

After a successful training process writes `weights.safetensors`, the manager
builds an inference-only wheel in the job's `dist/` directory and records
`model-package.json`. The wheel contains `GraphNet`, the resolved graph, its
custom operations and a declarative input adapter; it does not require
Lightning, W&B or the training dataset at inference time. The owner downloads
it through `GET /jobs/{job_id}/package`.

The training sidebar accepts a package-name suffix such as
`mnist_classifier`; it sends the full, Python-importable name
`nnm_mnist_classifier`. The backend validates the required `nnm_` prefix and
allows only letters, digits and underscores after it. When no suffix is
provided, it uses the unique fallback `nnm_job_<job-id>`.

## Integration tests and model selection

The integration model test always reads a non-converted Svelte Flow diagram,
runs the frontend type engine, fails on any hard type error, and only then
compiles to NNTree. The default fixture is the small MNIST MLP:

```bash
pnpm --dir front-end test:integration:model
```

Select another source model with an absolute path or a path relative to the
repository root:

```bash
NNM_MODEL_PATH=examples/diagrams/transformer_classifier.json \
  pnpm --dir front-end test:integration:model
```

Paths under `examples/nntrees/` are rejected so a pre-converted fixture cannot
silently bypass the type check. `NNM_DIAGRAM=mninst` remains available for the
existing tiered integration pipeline; `NNM_MODEL_PATH` is the explicit path
selector for source-model validation.

## Verification performed

The implementation was verified with:

- 293 frontend unit tests passed, 5 skipped;
- frontend production build passed;
- frontend `svelte-check`: 0 errors (11 existing warnings);
- source-model integration test: 3 passed for `examples/diagrams/mninst.json`;
- source-model integration test: 3 passed for `examples/diagrams/transformer_classifier.json`;
- direct Chrome load test: `transformer_classifier.json` loaded 24 nodes with
  no load error; the expected `Embedding` dtype warning remains visible because
  the generic `Input` is `float32` while embedding indices require `int64`;
- 112 Python non-training tests passed;
- MCP build and tests: 45 tests passed;
- live FastAPI + Valkey smoke test: dataset discovery, queued priority job,
  artifact creation, logs endpoint and cancellation;
- MCP stdio smoke test: 48 registered tools, including dataset and compute-unit
  proxy tools, plus browser `ping` and type inspection.

The two pre-existing `test_main.py` training smoke tests were not included in
the final verification run because their subprocesses stalled without output
in this environment while preparing/downloading MNIST. They remain separate
from the fast backend and source-model integration checks.
