---
id: T05
kind: task
status: draft
plan: ../plan.md
role: operations
depends_on: [T03, T04]
parallel_with: []
write_scope:
  - converted/src/backend/executors/
  - converted/src/package_worker.py
  - converted/backend/Dockerfile
  - converted/backend/docker-compose.yml
  - converted/backend/justfile
  - converted/backend/README.md
  - converted/src/tests/test_container_executor.py
---

# Run package jobs in isolated containers

## Objective

Add an executor that launches a short-lived package worker through a configured
Podman/Docker-compatible engine with reproducible images, explicit limits and
the same heartbeat/log/cancel callback contract as existing executors.

## Context required

- [Initiative plan](../plan.md)
- Accepted T01 trust/resource policy.
- `converted/src/backend/executors/base.py`
- `converted/src/backend/executors/local.py`
- `converted/src/backend/executors/slurm.py`
- `converted/backend/Dockerfile`
- `converted/backend/docker-compose.yml`
- `converted/backend/justfile`

## Invariants

- No shell interpolation of user-controlled values. Build argv arrays and
  validate engine/image/volume configuration before execution.
- A submitted package never runs in the long-lived backend process.
- Job input is read-only; only the assigned artifact directory is writable.
- CPU/RAM/PID/time/GPU/network/capability policies are explicit and tested.
- Podman is supported through configuration and Docker compatibility is tested
  through the same executor contract; no engine-specific behavior is silently
  assumed.

## Allowed files

- Executor implementations, worker entrypoint, container deployment assets,
  operator README and focused executor tests listed in `write_scope`.

## Out of scope

- Kubernetes, a public container registry, automatic image building from
  user-submitted Python or a general-purpose host sandbox.
- Rewriting the historical Slurm executor unless needed for a clearly scoped
  package-container mode.

## Work

1. Add the worker command and immutable input/output directory contract.
2. Implement engine selection (`podman`/`docker`/configured wrapper), image
   digest validation, resource flags, network policy, cancellation and timeout.
3. Decide and document the control-plane-to-engine boundary (rootless socket,
   dedicated runner or operator-managed host executor) and its security cost.
4. Add CPU image/Compose configuration and a documented GPU extension point;
   do not claim GPU support without a real smoke test.
5. Test command construction, path handling, cancellation, non-zero exit and
   log/heartbeat forwarding using a fake engine; run one real engine smoke test.

## Acceptance criteria

- [ ] The exact worker argv and mount/limit policy are asserted in tests.
- [ ] A package job cannot execute via the host `LocalExecutor` path.
- [ ] Podman works with the documented command and Docker-compatible mode uses
      the same contract.
- [ ] The backend/admin documentation explains engine socket privileges,
      image digests, volumes, network and cleanup.

## Validation

```bash
cd converted && uv run pytest src/tests/test_container_executor.py -q
just --justfile converted/backend/justfile health
```

## Required handoff

Return the engine configuration, image/runtime versions, security limitations,
real smoke-test command/result and any deferred GPU/Slurm constraints.
