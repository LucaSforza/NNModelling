---
id: wandb-integration
kind: plan
status: in_progress
updated: 2026-09-08
areas:
  - architecture
  - backend
  - operations
  - frontend
  - testing
---

# W&B training integration

## Goal

Provide one package-native Weights & Biases integration for NNModelling training.
The backend administrator owns one shared W&B account; browser users may choose
the project and one of `disabled`, `offline`, or `online`, but never receive or
submit credentials. Online jobs fail explicitly when the configured connection
or controlled egress is unavailable. Offline jobs remain network-isolated and
produce a downloadable W&B run.

This plan refines the accepted W&B and least-privilege requirements in the
[package backend decision](../../../knowledge/decisions/package-backend-standard.md).

## Current behavior

The frontend and API already carry a W&B project and mode, but both default to
`disabled`. The package worker rejects every non-disabled mode. The manager
tries to discover a run URL by scraping stdout/stderr with a regular expression,
and the worker image does not install the W&B SDK. There is no live legacy W&B
runtime to preserve; W&B material under `docs/archive/` and `analysis/` is
historical evidence rather than an executable implementation.

## Scope

- one worker-side tracking implementation for disabled, offline, and online
  runs;
- administrator-only connect, status, and disconnect commands for a shared
  service-account API key;
- W&B Cloud and self-hosted base URLs;
- operator-configured proxy/egress network policy for online workers;
- typed backend capability, job-status, SSE, and offline-download contracts;
- frontend connection status, typed controls, online run links, and verified
  offline-run downloads;
- removal of the worker rejection, log-scraping URL discovery, and any reachable
  W&B/Hydra/Lightning compatibility branch found during implementation.
- classification-only W&B observability that matches the standalone
  `examples/pytorch/transformer.spam.py` metrics, test report, confusion matrix,
  and elapsed training time while retaining loss-only logging for every dataset.

## Non-goals

- per-browser or per-user W&B credentials;
- entering or displaying an API key in the frontend or backend HTTP API;
- automatic fallback from online to offline or disabled;
- W&B sweeps, run resume, distributed/shared runs, dataset lineage, or uploading
  the model wheel as a W&B Artifact;
- retaining a second Lightning, Hydra, or NNTree logging implementation;
- deleting archived documentation merely because it describes historical code.
- classification telemetry for a dataset that does not declare `classes`.

## Decisions and invariants

- The administrator configures one shared account through local commands only.
  `wandb-connect` prompts for the key without accepting it in argv, verifies it
  against the selected Cloud or self-hosted base URL, and atomically stores a
  versioned credential file with owner-only permissions. `wandb-status` never
  prints the key; `wandb-disconnect` removes the local credential file.
- The browser request remains `{mode, project}`. Entity and base URL are fixed by
  the administrator. The run name is derived from the immutable NNModelling job
  ID and every job creates a new run.
- Disabled and offline jobs keep `network=none` and receive no credential.
- Online is available only when the controller has a valid credential file, an
  operator-selected container network, and a proxy URL. The named network is an
  operator security boundary and must prevent direct egress except through the
  allowlisting proxy. The controller never accepts a network name, proxy, base
  URL, entity, or secret from a browser job.
- The controller sends the bounded credential JSON to an online worker over the
  container's stdin and closes the stream before package code executes. The key
  never appears in argv, engine environment, mounts, logs, job input, artifacts,
  Valkey, status, events, or HTTP responses.
- The worker is the sole owner of W&B SDK calls. It records normalized training
  configuration and per-epoch `train/loss` and `validation/loss`, plus final
  best loss, completed epochs, and parameter count. W&B failures propagate and
  fail an explicitly online job.
- A dataset with `classes` is a classification dataset.  The worker derives one
  classification target only when the declared batch has exactly one target
  slot and it is either integral `[B]` class indices or numeric `[B, C]`
  class scores, where `C == classes.count`; the latter is reduced with
  `argmax`.  Other class metadata/target combinations fail before the epoch
  loop rather than guessing a target.  Prediction logits must be `[B, C]` and
  are reduced with `argmax`; this is validation of the existing package
  prediction program, not loss or package-ID inference.
- Every training mode keeps the current epoch loss curves.  For a classification
  dataset, W&B additionally receives per-epoch train/validation accuracy,
  precision, recall, F1, specificity (binary only), macro precision, macro
  recall and macro F1.  It receives final test values for the same applicable
  metrics, test example count, `training/seconds`, and a labelled W&B confusion
  matrix.  The raw integer matrix and its rows=actual/columns=predicted
  convention are retained in the run summary.  Binary precision/recall/F1 use
  class index 1, matching the transformer example; multiclass runs expose the
  macro metrics and matrix without inventing a positive class.
- The worker atomically writes `wandb-run.json`. Backend status and SSE consume
  that structured manifest; stdout/stderr URL scraping is removed.
- Offline W&B files live below the existing per-job artifact directory. Their
  authenticated ZIP download carries a SHA-256 response digest verified by the
  browser before saving.
- Existing pairing, ownership, priority/FIFO scheduling, cancellation, output
  limits, wheel export, and package-only execution remain unchanged.

## Contracts and control flow

Administrator credential file schema:

```json
{"schema_version": 1, "api_key": "<secret>", "base_url": "https://api.wandb.ai", "entity": "team"}
```

The controller-to-worker stdin protocol uses the same bounded JSON object and
is enabled only by the fixed `--wandb-credentials-stdin` worker flag generated
for an online job.

Authenticated browser capability response:

```json
{
  "available_modes": ["disabled", "offline", "online"],
  "online": {
    "configured": true,
    "entity": "team",
    "base_url": "https://api.wandb.ai",
    "reason": null
  }
}
```

When online is unavailable, `online` is omitted from `available_modes` and
`reason` is a non-secret operator-actionable message. Submission of an online
job is rejected before queue persistence.

The job and SSE use one structured run value:

```json
{
  "mode": "online",
  "id": "wandb-run-id",
  "entity": "team",
  "project": "project",
  "url": "https://.../runs/..."
}
```

Offline runs have `url: null` and become downloadable from
`GET /jobs/{job_id}/wandb/offline`. The old standalone `wandb_url` status field
and log-regex discovery are removed rather than retained as a second variant.

## Task graph

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [T01](tasks/T01-worker-and-credentials.md) | backend | — | T02, T03 | worker, credential module, dependency and focused tests | One worker tracker and safe administrator credential lifecycle |
| [T02](tasks/T02-controller-and-api.md) | operations | — | T01, T03 | controller, executor, backend API/manager and focused tests | Controlled online capability and structured backend lifecycle |
| [T03](tasks/T03-frontend.md) | frontend | — | T01, T02 | training frontend and focused tests | Typed connection-aware W&B UI and downloads |
| [T05](tasks/T05-classification-tracker.md) | backend | T01 | — | W&B tracker and focused tests | Classification-aware tracker API with no effect on loss-only runs |
| [T06](tasks/T06-classification-worker.md) | backend | T05 | — | package worker and focused tests | Data-driven classification metrics, test evaluation, and timing |
| [T04](tasks/T04-integration-and-verification.md) | integration | T01, T02, T03, T05, T06 | — | knowledge, operations docs, plan state | Integrated real-path proof and durable documentation |

T05 and T06 are intentionally sequential: the worker consumes the narrow
classification-tracking API established by T05.  They do not alter the already
completed controller or frontend write scopes.

## Integration and review gates

- No secret value may be present in a generated engine command, serialized job,
  persisted store value, log, artifact manifest, API response, or frontend state.
- A disabled/offline engine command must remain byte-for-byte network-isolated
  except for unrelated expected command changes.
- Online submission must fail before creating a job when controller capability
  is unavailable; runtime W&B failures must never downgrade the requested mode.
- The offline ZIP must be ownership-scoped, path-safe, snapshot-consistent, and
  digest-verified by the browser.
- Dependency and content searches must find no reachable W&B logger other than
  the package-native tracker and no remaining `wandb_url` log-scraping path.
- A dataset without `classes` must retain exactly its present loss logging and
  must neither execute a prediction pass nor emit classification keys.
- Classification derives only from dataset metadata, target tensor contracts and
  the explicit prediction program; it must not inspect objective Python,
  output-shape heuristics for loss selection, or package identifiers.

## Acceptance criteria

- [ ] Administrator commands safely connect, report, rotate, and disconnect the
      shared Cloud or self-hosted W&B account without revealing the key.
- [ ] Disabled training does not initialize W&B, receive a secret, or gain
      network access.
- [ ] Offline training records real W&B files, metrics, configuration, and a
      structured manifest without network or credentials; the browser downloads
      and verifies the offline ZIP.
- [ ] Online training is admitted only with configured credentials and
      controlled proxy/egress, exposes its run link through structured SSE/status,
      and fails rather than silently degrading when W&B is unavailable.
- [ ] Entity and base URL are administrator-owned; browser users choose only the
      mode and project.
- [ ] No wheel or dataset is uploaded as a W&B Artifact.
- [ ] The regex URL detector and every reachable deprecated W&B implementation
      are removed.
- [ ] A classified run shows transformer-parity epoch metrics, a final test
      report, labelled confusion matrix and elapsed seconds; a non-classified
      run still shows its loss curves only.
- [ ] Existing backend fast tests, frontend checks, package-only guard, and real
      user-facing offline path pass.

## Final verification

```bash
cd converted && uv run pytest src/tests/test_wandb_tracking.py src/tests/test_package_worker.py src/tests/test_container_controller.py src/tests/test_container_executor.py src/tests/test_remote_backend.py -q
cd converted && uv run pytest src/tests/ -m fast -q
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end guard:package-only
git diff --check
```

Exercise one offline classification training job through the live
editor/backend/controller, download the resulting archive through the UI,
verify its response digest, and confirm it contains a W&B `.wandb` run file,
the loss curves, classification metrics, test report, confusion matrix and
elapsed seconds. Exercise an offline non-classification job to prove that it
emits loss only. Exercise online capability rejection without credentials. A
real Cloud/self-hosted online smoke test is conditional on an
administrator-provided test credential and configured egress; never add a
credential to repository fixtures.

## Knowledge and archive impact

- Update `docs/knowledge/architecture/remote-training.md` with the accepted
  connection, egress, manifest, and offline artifact contracts.
- Update `docs/knowledge/decisions/package-backend-standard.md` so online W&B is
  described as an implemented opt-in policy instead of an unimplemented option.
- Update `converted/README.md` with administrator commands and egress setup.
- Preserve historical files under `docs/archive/` and `analysis/` unless a live
  source or test still imports them.
