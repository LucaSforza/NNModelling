---
kind: knowledge
status: current
updated: 2026-08-12
---

# Remote-training architecture

The optional training backend accepts a compiled NNTree and complete training
request, persists it in Valkey, schedules it, and produces recoverable
artifacts. The existing local conversion, training and inference CLI remains a
supported independent path.

```text
TrainingSidebar or MCP HTTP client
  -> FastAPI (`converted/src/backend/app.py`)
  -> Valkey job store and event streams
  -> JobManager priority/FIFO scheduler
  -> LocalExecutor or SlurmExecutor
  -> Hydra/Lightning artifacts
  -> model-package wheel
```

## Job contract

`JobSubmission` is versioned and rejects unknown top-level fields. Version 1
contains:

- `network`: compiled `nntree` payload;
- `training`: dataset, optimizer, trainer, W&B, early stopping and overrides;
- `resources`: CPU, memory, GPU and optional Slurm selectors;
- `priority` and optional `nnm_<name>` package name.

The current public lifecycle is:

```text
queued -> running -> succeeded
                  -> failed
                  -> cancelled
```

Valkey is the persistent control plane. Queue claiming is atomic, ordered by
priority and FIFO within a priority. Historical gaps recorded during issue #14
are archived in
[`issue-14-remaining-work.md`](../../archive/reports/remote-training-backend/issue-14-remaining-work.md)
and must be reassessed against current code before becoming a new plan.

## Boundaries

- The frontend and optional MCP client use the same FastAPI state; MCP does not
  duplicate jobs or scheduling.
- Hydra overrides are composed as configuration and are never shell commands.
- Local execution launches the repository's fixed training entry point.
- Slurm scripts are generated from validated resource fields and may be
  submitted locally or through a configured SSH host.
- Artifacts default to `converted/jobs/<job-id>/` and may be relocated with
  `NNM_BACKEND_ARTIFACT_ROOT`.
- Dataset discovery imports installed trusted dataset classes and exposes
  constructor metadata without uploading dataset code.
- Job access is scoped to an authenticated browser connection; see
  [Pairing and ownership](../contracts/pairing.md).
- Successful jobs may emit a portable wheel; see
  [Model packages](../contracts/model-package.md).

## Principal code

- `converted/src/backend/app.py`: HTTP and SSE API.
- `converted/src/backend/models.py`: public request and status contracts.
- `converted/src/backend/store.py`: persistence and queue operations.
- `converted/src/backend/manager.py`: scheduling and lifecycle coordination.
- `converted/src/backend/executors/`: local and Slurm boundaries.
- `front-end/src/components/TrainingSidebar.svelte`: browser workflow.
- `front-end/src/training/api.ts`: browser REST/SSE client.
- `mcp-server/src/remote-training.ts`: optional authenticated HTTP client.
