---
kind: knowledge
status: current
updated: 2026-09-08
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
  -> Podman/Docker container controller (network=none or operator W&B policy)
  -> package worker (sole W&B SDK owner)
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
- W&B `disabled` and `offline` jobs receive neither credentials nor network;
  `online` jobs use the administrator-owned controller policy described below.
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
- `converted/src/backend/wandb_credentials.py`: strict shared credential file
  and bounded controller-to-worker stdin contract.
- `converted/src/training/wandb_tracking.py`: the sole W&B SDK integration.
- `front-end/src/components/TrainingSidebar.svelte`: browser workflow.
- `front-end/src/training/api.ts`: browser REST/SSE client.
- `mcp-server/src/remote-training.ts`: optional authenticated HTTP client.

Wheel downloads require `GET /jobs/{id}/package?packageName=nnm_<suffix>`.
`packageName` is validated server-side and is never accepted in
`JobSubmission` or persisted training configuration. The backend rebuilds the
wheel package directory and dist-info under that name, recomputes `RECORD`,
and returns the digest of those exact bytes in `X-NNM-SHA256`. Clients must
verify that response digest and the downloaded body.

## W&B connection and artifacts

The browser submits only `{mode, project}`. The shared `entity`, API base URL
and API key belong to the backend administrator. The authenticated
`GET /capabilities` response exposes only sanitized availability metadata.
An `online` submission is rejected before job persistence unless the trusted
controller can read a valid owner-only credential file and has both an
operator-selected container network and proxy URL.

The online network name is a closed controller policy, not browser input. Its
operator-managed firewall must deny direct egress and permit only the
allowlisting proxy. The controller passes proxy settings in the container
environment, but sends the bounded credential JSON separately through the
worker's stdin and closes the pipe before training starts. The key is absent
from the engine command, RPC request, job document, mounts, logs, artifacts,
events and HTTP responses. An online SDK failure fails the job; it never falls
back to offline or disabled.

The proxy allowlist is destination-based and is not limited to the configured
W&B API host. In the currently verified W&B Cloud flow, API traffic uses
`api.wandb.ai` while run-file upload may use `storage.googleapis.com`.
Operators must derive any additional destination from sanitized proxy or SDK
logs, add only the required host, and retain default-deny behavior for all
other egress. These observed Cloud endpoints are operational evidence, not a
permanent exhaustive vendor contract.

A fresh worker heartbeat plus repeated upload messages means finalization may
still be active. Optional SDK telemetry timeouts do not by themselves make a
run unsuccessful; the terminal backend state and the structured W&B and model
package manifests remain the acceptance boundary.

The worker records `train/loss` and `validation/loss` per epoch and final best
loss, completed epochs and parameter count. It derives a new run name from the
immutable job ID and atomically publishes `wandb-run.json`. Backend status and
SSE consume this manifest; they never scrape logs for a URL. The manifest has
one `offline`/`online` shape, and online URLs are accepted only when they are
absolute HTTP(S) URLs without user information.

Offline W&B files live under the owned job artifact directory while the worker
still has `network=none`. A terminal offline job exposes an authenticated ZIP
snapshot at `GET /jobs/{id}/wandb/offline`; the backend hashes the exact served
bytes in `X-NNM-SHA256`, which the browser verifies before saving. Dataset,
weights and wheel files are not uploaded as W&B Artifacts.

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
