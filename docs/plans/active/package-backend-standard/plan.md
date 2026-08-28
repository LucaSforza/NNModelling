---
id: package-backend-standard
kind: plan
status: in_progress
updated: 2026-08-27
areas:
  - architecture
  - backend
  - operations
  - frontend
  - testing
---

# Standard package backend

## Goal

Make the PR43 package graph the only backend network format and execute its
training in a least-privilege Podman/Docker worker. The backend must produce
the existing portable Python wheel contract while removing dependencies on the
NNTree conversion pipeline.

The proposed architecture is recorded in
[`docs/knowledge/decisions/package-backend-standard.md`](../../../knowledge/decisions/package-backend-standard.md).
Prediction and objective execution are refined by the accepted
[`prediction-objective-programs`](../../../knowledge/decisions/prediction-objective-programs.md)
decision and its focused
[`implementation plan`](../prediction-objective-programs/plan.md).

## Scope

- typed package-bundle and training-job contracts;
- bounded, authenticated, immutable bundle storage;
- a package-native compiler and trainer that run only in a worker;
- a separate `ContainerController` for rootless Podman and Docker;
- verified wheel export and download;
- frontend, API, SSE, cancellation and ownership parity;
- removal of NNTree request, conversion, host-executor and compatibility code
  from the backend standard;
- tests proving security boundaries, training semantics, artifacts and the
  real user-facing CPU path.

## Explicit removals

The implementation must remove, rather than preserve behind a format flag:

- `network.format == "nntree"` from the backend request/status contract;
- `build_job_hydra_configs()` and the backend's NNTree materialization branch;
- `converted/src/convert.py` as a backend dependency;
- `LocalExecutor` and `SlurmExecutor` from backend scheduling;
- NNTree-only `main.py`, `net/`, `ops/` and dataset/config wiring once no active
  package-native exporter imports them;
- `package_worker._run_legacy()` and legacy package fixtures;
- the `training_package` status/API/UI path and `nnm-trained-package/v1` ZIP.
- MCP/browser `compile_nntree`, `execute_conversion` and `convert.py` pipeline;
- frontend Hydra override fields and free-form override request data;
- Hydra/OmegaConf dependencies and current NNTree/Hydra documentation after
  package-native replacements pass their gates.

The portable wheel remains a product contract, but its exporter/runtime must be
rewritten to consume the package graph and package resources instead of Hydra
or NNTree configuration. No deletion is made until the dependency check in
P01 and the package wheel gate in P05 pass.

## Non-goals

- Kubernetes in the first release;
- a browser-side Python runtime or Lua-to-PyTorch fallback;
- arbitrary host paths, dataset imports or network package installation;
- a public package marketplace or dependency solver;
- keeping a silent legacy fallback for failed package jobs.

## Implementation phases

### P01 — Freeze contract and remove legacy dependency surface

Create the package-only request/status models, typed training specification,
capability errors and a dependency inventory. Remove NNTree dispatch from the
backend and isolate/delete legacy modules only after `rg` proves they are not
reachable from the package path. Keep the existing pairing, Valkey, SSE and
job ownership primitives.

### P02 — Bundle validation and storage

Replace the unbounded JSON/base64 upload with a bounded canonical archive
transport. Validate schema/version, normalized paths, duplicate entries,
declared resources, dependency closure, graph topology, source/file/archive
limits and digest before persisting anything. Store immutable content by
digest, maintain ownership as a separate ACL, use put-if-absent semantics and
return typed 404/403/422 errors. Invalid submissions create no job directory.

### P03 — Worker-only runtime and package-native training

Move all package loading and graph compilation behind the worker boundary.
The runtime must load exact package IDs/versions in a generated namespace and
compile shared modules into separate prediction and objective programs. Loss
packages bind targets through their declarative stereotype contract; output
shape/dtype dispatch, Python signature inspection and package-ID switches are
forbidden. Implement a typed trainer that applies every accepted UI field,
seeds before model/dataset/loader creation, records normalized config, supports
deterministic CPU execution and rejects unsupported accelerator, W&B, dataset
or optimizer options.

### P04 — ContainerController and executor adapters

Implement a trusted controller process reachable only through a local
authenticated Unix socket. FastAPI sends a server-generated
`ContainerJobSpec`; the controller owns the Podman/Docker capability, starts
one short-lived rootless container, streams logs/heartbeats, enforces timeout,
resource and mount policy, and handles cancellation/recovery. Podman and
Docker use the same spec and worker command. The controller must reject
client-provided engine flags, commands, images and host paths.

### P05 — Package-native wheel export

Build the portable wheel inside the worker after training succeeds. Include
the resolved package graph, exact package PyTorch resources, runtime,
declarative input adapter and verified safetensors. Persist the manifest only
after the wheel digest is computed. A job reaches `succeeded` only after this
commit; `/jobs/{id}/package` remains the sole artifact download endpoint.

### P06 — Frontend/API integration

Keep `DiagramCore` as the graph authority and submit its package bundle and
typed training request. Surface capability/validation errors before queueing,
show container/job lifecycle through the existing authenticated SSE flow,
remove the training ZIP UI/API and keep SHA-256 wheel verification.

### P07 — Removal and verification gate

Run dependency and dead-code checks, package compiler/trainer unit tests,
controller fake-engine tests, frontend gates, backend fast tests and one real
CPU job through the browser/API. Verify a downloaded wheel in a clean
environment without the repository checkout. Verify invalid source cannot
touch the control plane, unknown references are typed errors, ownership cannot
be overwritten, and unsupported capabilities fail before queueing.

The focused
[`prediction-objective-programs`](../prediction-objective-programs/plan.md)
initiative owns the ordered frontend/MCP removal and final Python/dependency
deletion tasks. Its package replacement gates must pass before P07 considers
the legacy stack unreachable.

## Container least-privilege contract

The controller must generate an argv equivalent to:

```text
<podman|docker> run --rm --read-only --network none
  --cap-drop ALL --security-opt no-new-privileges
  --pids-limit <limit> --cpus <cpu> --memory <memory>
  --mount input:ro --mount artifacts:rw
  <allowlisted-image@sha256:digest>
  python -m package_worker --input /input/job.json --artifacts /artifacts
```

The worker runs as a non-root user with the engine's default seccomp and host
MAC policy. The input bundle and operator-managed dataset are read-only; only
the per-job artifact directory is writable. No engine socket, host root,
credentials, arbitrary device or client-selected volume is available inside
the worker. Network access is an explicit operator capability and defaults to
none.

## Kubernetes boundary

Kubernetes is deferred. If multi-node scheduling, autoscaling, GPU allocation,
high availability or tenant separation later justifies it, a Kubernetes
executor will consume the same validated `ContainerJobSpec`. It must not leak
Kubernetes concepts into the package, training or frontend contracts.

## Acceptance criteria

- [ ] Only `network.format = "package"` is accepted by the backend.
- [ ] No FastAPI code imports, compiles, instantiates or executes package
      Python.
- [ ] Every package job runs through the controller in Podman or Docker, or is
      rejected with an explicit capability error.
- [ ] Every training field is applied, normalized or rejected; none is silently
      ignored.
- [ ] The compiler exposes separate prediction and objective programs over one
      shared parameter set, and the trainer contains no inferred-loss fallback.
- [ ] A wheel invokes the explicit prediction output without a target even when
      the training graph contains objectives.
- [ ] A successful package job yields an installable, self-contained wheel and
      no public training ZIP.
- [ ] The old NNTree conversion/executor modules are unreachable and removed
      from the backend standard.
- [ ] Pairing, ownership, queue ordering, SSE, logs and cancellation remain
      correct for the package path.
- [ ] A clean-environment wheel smoke test and real container CPU smoke test
      pass for both engine adapters where available.

## Validation commands

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end guard:package-only
cd converted && uv run pytest src/tests/ -m fast -q
git diff --check
```

## Task graph

| Task | Depends on | Observable result |
| --- | --- | --- |
| [P01](tasks/P01-contract-and-legacy-removal.md) | — | Package-only contract and legacy dependency inventory/removal boundary |
| [P02](tasks/P02-bundle-storage.md) | P01 | Bounded immutable bundle upload with ownership and typed errors |
| [P03](tasks/P03-runtime-and-training.md) | P01, P02 | Worker-only compiler and complete typed package trainer |
| [P04](tasks/P04-container-controller.md) | P01, P03 | Least-privilege Podman/Docker controller and executor |
| [P05](tasks/P05-wheel-export.md) | P03, P04 | Portable wheel produced and verified inside the worker |
| [P06](tasks/P06-frontend-api.md) | P02, P05 | Package-only browser training lifecycle and wheel download |
| [P07](tasks/P07-verification-and-cleanup.md) | P04, P05, P06 | Real-interface proof and deletion of unreachable legacy code |
