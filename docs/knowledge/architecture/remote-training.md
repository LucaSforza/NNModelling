---
kind: knowledge
status: current
updated: 2026-08-12
---

# Remote-training architecture

The backend is package-native. The accepted package-only target, including its
least-privilege Podman/Docker controller, is defined in the
[package backend decision](../decisions/package-backend-standard.md) and the
[active implementation plan](../../plans/active/package-backend-standard/plan.md).

```text
TrainingSidebar or MCP HTTP client
  -> FastAPI (`converted/src/backend/app.py`)
  -> Valkey job store and event streams
  -> JobManager priority/FIFO scheduler
  -> Podman/Docker container controller
  -> training artifacts
```

## Job contract

`JobSubmission` is versioned and rejects unknown top-level fields. Version 1
contains:

- `network`: a `package` bundle reference plus semantic graph;
- `training`: dataset, optimizer, trainer, W&B and early stopping;
- `resources`: CPU, memory, GPU and optional controller selectors;
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
- The API validates typed package/training data and never imports package
  Python in FastAPI.
- The accepted target launches exactly one short-lived worker container per job
  through a Podman/Docker controller.
- Artifacts default to `converted/jobs/<job-id>/` and may be relocated with
  `NNM_BACKEND_ARTIFACT_ROOT`.
- Dataset discovery and package execution follow the registered-dataset and
  worker-only policy.
- Job access is scoped to an authenticated browser connection; see
  [Pairing and ownership](../contracts/pairing.md).
- The package path emits the portable wheel contract. See
  [Model packages](../contracts/model-package.md).

## Principal code

- `converted/src/backend/app.py`: HTTP and SSE API.
- `converted/src/backend/models.py`: public request and status contracts.
- `converted/src/backend/store.py`: persistence and queue operations.
- `converted/src/backend/manager.py`: scheduling and lifecycle coordination.
- `converted/src/backend/container_controller.py`: Podman/Docker boundary.
- `front-end/src/components/TrainingSidebar.svelte`: browser workflow.
- `front-end/src/training/api.ts`: browser REST/SSE client.
- `mcp-server/src/remote-training.ts`: optional authenticated HTTP client.
