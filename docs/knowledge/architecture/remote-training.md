---
kind: knowledge
status: current
updated: 2026-08-29
---

# Remote-training architecture

The backend is package-native. The accepted package-only target, including its
least-privilege Podman/Docker controller, is defined in the
[package backend decision](../decisions/package-backend-standard.md) and the
[active implementation plan](../../plans/active/package-backend-standard/plan.md).

```text
TrainingSidebar
  -> browser TrainingController/API
  -> FastAPI (`converted/src/backend/app.py`)

Selected-editor MCP workflow
  -> BrowserRPCHandler -> browser TrainingController/API
  -> FastAPI (`converted/src/backend/app.py`)

Legacy MCP compatibility tools
  -> RemoteTrainingClient (`NNM_BACKEND_URL`/`NNM_BACKEND_TOKEN`)
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
- `training`: an opaque resolved dataset reference with typed parameters,
  optimizer, trainer, W&B and early stopping;
- `resources`: CPU, memory, GPU and optional controller selectors;
- `priority` only; the importable wheel name is selected at download time.

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

- The frontend and selected-editor MCP workflow share the browser's
  `TrainingController`; legacy MCP compatibility tools use the process-configured
  HTTP client. Neither path duplicates jobs or scheduling, and they must not be
  silently treated as the same connection owner.
- The API validates typed package/training data and never imports package
  Python in FastAPI.
- The accepted target launches exactly one short-lived worker container per job
  through a Podman/Docker controller.
- Artifacts default to `converted/jobs/<job-id>/` and may be relocated with
  `NNM_BACKEND_ARTIFACT_ROOT`.
- Project dataset archives are bounded, content-addressed and
  ownership-scoped; their Python executes only inside the worker. See
  [Project-owned datasets](../decisions/project-owned-datasets.md).
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

Wheel downloads require `GET /jobs/{id}/package?packageName=nnm_<suffix>`.
`packageName` is validated server-side and is never accepted in
`JobSubmission` or persisted training configuration. The backend rebuilds the
wheel package directory and dist-info under that name, recomputes `RECORD`,
and returns the digest of those exact bytes in `X-NNM-SHA256`. Clients must
verify that response digest and the downloaded body.

## MCP provenance

Connection/configuration/submission operations are editor-scoped only when they
traverse `BrowserRPCHandler` and the paired browser API. The public
`read_training_progress` and `download_training_wheel` tools remain compatibility
operations through `RemoteTrainingClient`. The distinct
`read_editor_training_progress` and `download_editor_training_wheel` tools route
through `BrowserRPCHandler` and the paired browser identity. The latter verifies
the wheel in the browser, then the MCP server writes it to a private,
non-overwriting artifact path. Results expose only route-safe metadata and never
bearer tokens.
