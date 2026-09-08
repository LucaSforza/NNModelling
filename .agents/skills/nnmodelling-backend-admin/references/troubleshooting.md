# Backend troubleshooting

Start with evidence, preserve current jobs, and repair the narrowest boundary.
Never print token or credential files while diagnosing.

## Fast triage

Collect sanitized state:

```bash
.agents/skills/nnmodelling-mcp/scripts/nnm-stack.sh status
just --justfile converted/backend/justfile health
just --justfile converted/backend/justfile container-config
just --justfile converted/backend/justfile wandb-status
just --justfile converted/backend/justfile pairing-pending
just --justfile converted/backend/justfile sessions
just --justfile converted/backend/justfile admin-jobs
```

For one job, record its ID, status, executor, created/started/finished times,
heartbeat, error, diagnostics, W&B manifest, model-package manifest, and bounded
stdout/stderr tail. A fresh heartbeat means the worker/controller path is
alive even when no new epoch metric appears.

## Service and connectivity failures

### Backend health is unreachable

Likely causes are a missing/short-lived FastAPI process, port collision, wrong
host/port, or unavailable Valkey.

1. Inspect the expected listener and owning PID; reuse a healthy process.
2. Confirm Valkey is listening on the configured `NNM_VALKEY_PORT` and the
   backend uses the matching `NNM_VALKEY_URL`.
3. Keep foreground services in persistent terminals. A command launched from a
   transient executor may be killed even though startup initially succeeded.
4. Start only the missing component, then rerun `health`.

Do not solve a collision by incrementing ports silently; the editor, MCP, CORS,
and admin URL must agree on the chosen endpoint.

### Browser reports a network or CORS error

Compare the browser's exact Origin with `NNM_ALLOWED_ORIGINS`, including scheme,
hostname, and port. `http://localhost:5174` and
`http://127.0.0.1:5174` are distinct. Configure a comma-separated exact
allowlist and restart only FastAPI. CORS is not authentication; do not replace
the allowlist with `*`.

### Pairing stays pending or requests are unauthorized

- Confirm the request has not exceeded its short TTL.
- Match device name, Origin, and code before approval.
- Inspect `sessions` for expiry or revocation.
- Renew through the existing browser connection when possible to preserve job
  ownership; otherwise pair again and accept the new ownership identity.
- After backend/controller restarts, re-run the browser's
  `get_training_connection`; do not assume cached frontend state is valid.

## Controller and worker failures

### Capability says `container controller unavailable`

Check that the controller is long-lived and that backend and controller agree
on:

- `NNM_CONTAINER_CONTROLLER_SOCKET`;
- `NNM_CONTAINER_CONTROLLER_TOKEN_FILE`;
- `NNM_CONTAINER_DATA_ROOT` and artifact roots;
- `NNM_CONTAINER_ENGINE`.

Verify the Unix socket directory exists with owner-only access and that only
the controller has the engine socket. Restart the failed side after correcting
the mismatch; do not mount the engine socket into FastAPI.

### Jobs queue but never obtain a compatible executor

Inspect `NNM_CONTAINER_IMAGE` and `container-config`. The image reference must
be digest-pinned and compatible with the current repository's worker protocol.
Confirm the chosen engine can inspect/run it and that requested CPU/RAM are
available. GPU jobs are not supported by the current container executor; do not
advertise GPU capability or silently downgrade the request.

### Worker rejects `--wandb-credentials-stdin` or cannot import `wandb`

The worker image is stale or was built incompletely. Rebuild it coherently from
the current `converted/pyproject.toml`, `converted/uv.lock`, source tree, and
checked-in Dockerfile; verify `python -m package_worker --help` and a sanitized
`import wandb`; then configure the new digest reference on FastAPI, which passes
it to the controller. Do not hot-patch a running worker or use a mutable tag.

### Job heartbeat is stale

Inspect controller and engine state plus the job's last heartbeat before taking
action. Distinguish a live but quiet epoch from a lost worker. Let the manager's
recovery contract reconcile stale work; do not edit Valkey job records by hand.
Cancel only with the user's authorization when recovery cannot complete.

## Dataset and project failures

### Dataset upload is rejected as too large

Read the exact compressed, per-file, expanded, or file-count diagnostic. Choose
one supported policy:

- keep default bounds and reduce/fix the archive;
- restart FastAPI with a justified finite `--max-dataset-size`;
- use the explicitly unsafe unlimited target only when the user requested it.

Never label unlimited mode as fully unvalidated: file-count, path/ZIP,
metadata, ownership, and digest checks remain mandatory.

### A project dataset reference becomes unknown after backend restart

Confirm the submitted dataset reference belongs to the current paired
connection and exists in backend state. If the browser cached a reference from
the previous backend lifetime, reopen the active project through the
browser-backed MCP workflow so the dataset is republished, then resubmit.
Preserve the content-addressed ID/digest; do not fabricate or rewrite it.

### Package upload succeeds but job creation fails

Inspect the job-creation response and backend logs before retrying. Common
boundaries are an owner-scoped dataset reference, incomplete online W&B
capability, an unsupported executor/resource request, or stale browser pairing.
A failed submission must not leave an orphan job; verify `admin-jobs` before a
second attempt.

## W&B failures

### Online mode is unavailable before queueing

Use `wandb-status` and the authenticated capabilities response. All of these
must be valid:

- owner-only credential file with an API key and accessible entity;
- API base URL;
- configured controller network;
- HTTP(S) proxy URL without embedded credentials;
- running trusted controller.

Use `wandb-connect` to validate credentials interactively. Do not infer the
entity from an organization URL slug; use an entity the authenticated account
can actually create runs under.

### W&B authenticates but final upload repeats or times out

Do not cancel while job heartbeats are fresh. Inspect sanitized proxy denials
and W&B debug logs for the requested host. Keep direct egress denied and add
only evidence-backed W&B storage hosts to the proxy allowlist. In the current
tested W&B Cloud flow, API traffic uses `api.wandb.ai` and file upload may use
`storage.googleapis.com`; this is observed behavior, not a permanent exhaustive
vendor list. Verify allowed CONNECT/TLS succeeds and an unrelated host remains
denied, then allow the existing job to finish.

Optional SDK telemetry failures under `/sdk/otel/` may coexist with successful
run/file synchronization. The acceptance condition is a terminal job plus the
structured `wandb_run` and model-package manifests, not the absence of every
telemetry warning.

### W&B run exists but the browser shows 404

Private runs appear as 404 to a browser session that is not logged in or lacks
workspace access. Verify the structured run URL/ID and successful sync from the
job manifest/logs. Do not place an API key in a URL or browser storage to bypass
interactive login; the user must authenticate the web session normally.

### Online failure occurs after training

Online errors fail the job by design; never relabel the run offline or silently
fall back. Correct the credential/network/proxy/image boundary and submit a new
job. Preserve the failed job and logs for diagnosis.

## Artifact and MCP failures

### Wheel download rejects the destination

The selected-editor MCP tool writes only to its private artifact root and never
overwrites. Omit `destinationPath` for the safe default, or choose a new file
inside the configured private root. Do not weaken path confinement.

### MCP has no selected browser tab or project root

This is a browser/MCP lifecycle issue, not a reason to modify backend state.
Load `nnmodelling-mcp`, reuse one MCP listener on `9339`, select the intended
in-app Browser tab, and start MCP with the intended `NNM_PROJECT_ROOT` before
calling `open_project`.

## Verification after a repair

Use the smallest proof that crosses the repaired boundary:

- service repair: `health` plus connection capability;
- pairing repair: active `get_training_connection` under the same owner when
  ownership preservation is expected;
- controller/image repair: one representative worker container;
- dataset repair: republish and resolve the same project dataset;
- W&B repair: an online job with structured run manifest and synchronized
  files;
- artifact repair: digest-verified wheel download and public-model smoke test.

Then confirm no unrelated service was stopped, no secret was exposed, and no
user-owned repository change was altered.
