---
id: T02
kind: task
status: done
plan: ../plan.md
role: operations
depends_on: []
parallel_with: [T01, T03]
write_scope:
  - converted/src/backend/container_controller.py
  - converted/src/backend/executors/base.py
  - converted/src/backend/executors/container.py
  - converted/src/backend/models.py
  - converted/src/backend/manager.py
  - converted/src/backend/app.py
  - converted/backend/justfile
  - converted/backend/docker-compose.yml
  - converted/.gitignore
  - converted/src/tests/test_container_controller.py
  - converted/src/tests/test_container_executor.py
  - converted/src/tests/test_backend_models.py
  - converted/src/tests/test_remote_backend.py
---

# Add controlled egress and structured backend lifecycle

## Objective

Admit online W&B jobs only through a configured controller policy, deliver the
credential over bounded stdin, and expose one structured capability/run/offline
download contract through the authenticated backend.

## Context required

- Read the [initiative](../plan.md),
  [remote-training architecture](../../../../knowledge/architecture/remote-training.md),
  [package backend decision](../../../../knowledge/decisions/package-backend-standard.md),
  and current controller/executor/manager/API tests.
- Treat the credential schema and `--wandb-credentials-stdin` flag in the plan as
  frozen even if T01 is still running.

## Invariants

- Browser/job data selects only `disabled`, `offline`, or `online` plus project;
  it cannot select credentials, entity, base URL, proxy, or engine network.
- Disabled/offline retain `--network none` and no stdin secret.
- Online uses the operator-configured network and proxy, with a controller-owned
  credential file streamed to the worker stdin after launch and immediately
  closed. No secret enters argv, environment, RPC, logs, job data, or status.
- The named online network must be explicitly configured and documented as an
  operator-enforced route to the allowlisting proxy; absence is unavailable.
- Invalid online capability is rejected before job persistence/queueing.
- Ownership, lifecycle, cancellation, log limits, and wheel behavior remain.

## Allowed files

Only the files in `write_scope`. Use exact existing tests rather than adding a
second controller or API module outside this boundary.

## Out of scope

- W&B SDK calls, credential CLI implementation, Svelte/TypeScript, public docs,
  general Internet access, proxy deployment, and W&B Artifact uploads.

## Work

1. Replace free-form network strings with a closed controller policy
   (`none`/`wandb`) whose W&B branch maps only to operator configuration.
2. Extend the controller service configuration and RPC with sanitized W&B status;
   add the stdin secret handoff without command/env/log exposure.
3. Add administrator `just` commands and compose plumbing for credential path,
   W&B network, and proxy while retaining secure defaults.
4. Add the authenticated capability endpoint and reject unavailable online jobs
   before persistence.
5. Replace `wandb_url` and log regex discovery with structured
   `wandb-run.json` status/SSE handling.
6. Add ownership-scoped offline ZIP download with a SHA-256 header and safe,
   snapshot-consistent reads.
7. Add focused security, API, lifecycle, and regression tests.

## Acceptance criteria

- [ ] Engine command tests prove secret absence and correct mode-specific network.
- [ ] Capability and prequeue rejection reflect live controller configuration.
- [ ] Structured run state/SSE and offline download replace the old URL variant.
- [ ] No changes outside `write_scope`.

## Validation

```bash
cd converted && uv run pytest src/tests/test_container_controller.py src/tests/test_container_executor.py src/tests/test_backend_models.py src/tests/test_remote_backend.py -q
```

## Required handoff

Return changed files, exact tests/results, the final sanitized API shapes, and
any assumptions or integration risks. Never include credential contents.
