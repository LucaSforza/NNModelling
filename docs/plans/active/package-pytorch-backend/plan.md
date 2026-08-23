---
id: package-pytorch-backend
kind: plan
status: draft
updated: 2026-08-23
areas:
  - architecture
  - frontend
  - backend
  - operations
  - testing
---

# Package PyTorch backend integration

## Goal

Allow a valid package-format diagram to be submitted from the browser and
executed by the Python backend using the `pytorch.py` entrypoint declared by
each stereotype package. Package loading, graph compilation, training and
inference must run in an isolated, reproducible container selected through a
Docker-compatible engine, with Podman as the primary operator choice. The
existing NNTree training path remains available during migration.

## Current behavior

The current frontend is package-driven and browser-owned. `DiagramCore` stores
the graph, exact package identities, primitive parameters and ordered edge
handles; the browser executes package-owned Lua for type inference. The browser
catalog currently loads only `manifest.json`, `stereotype.json` and
`inference.lua` ([`front-end/src/type-system/bundled/catalog.ts`](../../../../front-end/src/type-system/bundled/catalog.ts)).
Although the manifest type already declares an optional PyTorch entrypoint,
the loader activates only Lua ([`front-end/src/type-system/packages/types.ts`](../../../../front-end/src/type-system/packages/types.ts),
[`front-end/src/type-system/packages/loader.ts`](../../../../front-end/src/type-system/packages/loader.ts)).

The backend accepts only `network.format: "nntree"`, turns it into Hydra
configuration and schedules a host Python process or a Slurm script
([`converted/src/backend/models.py`](../../../../converted/src/backend/models.py),
[`converted/src/backend/config_service.py`](../../../../converted/src/backend/config_service.py),
[`converted/src/backend/executors/local.py`](../../../../converted/src/backend/executors/local.py)).
The current frontend training request is intentionally disabled because the
package runtime does not exist ([`front-end/src/components/TrainingSidebar.svelte`](../../../../front-end/src/components/TrainingSidebar.svelte)).
Docker Compose already containerizes the control plane and Valkey, but it does
not create an isolated container for each training process.

The package entrypoints already show the intended backend shape: a module
exports `build(parameters, context, services)` and imports the shared
`stereotype_runtime.pytorch` contract. For example, see
[`stereotype-packages/core/linear/pytorch.py`](../../../../stereotype-packages/core/linear/pytorch.py)
and [`stereotype-packages/core/horizontal-repeat/pytorch.py`](../../../../stereotype-packages/core/horizontal-repeat/pytorch.py).

## Scope

- Define a versioned package-job protocol that carries the semantic graph,
  exact package identities, primitive parameters, containment and
  `targetHandle` ordering, plus the PyTorch resources required by the graph.
- Extend the browser catalog/export path to collect the dependency closure and
  expose `pytorch.py` without making Python part of frontend type inference.
- Add a Python package registry, runtime contract and graph compiler that call
  package `build()` factories, including subflow and stereotype services.
- Add an authenticated package-bundle upload/reference flow while preserving
  job ownership, size limits, digest verification and the existing SSE/job
  lifecycle.
- Add a per-job container executor with a configurable engine command
  (`podman` by default, `docker` or a Docker-compatible wrapper by
  configuration), pinned CPU/GPU images, resource limits and safe artifact
  mounts.
- Connect the existing training UI/API to package jobs and retain the current
  model-package download integrity contract for successful outputs.
- Add focused frontend, Python, API, container-command and one real
  end-to-end package-job verification path.

## Non-goals

- Executing PyTorch in the browser or using PyTorch as a type-inference
  fallback. Lua remains the sole frontend semantic authority.
- Accepting arbitrary unreviewed Python as a trusted in-process backend plugin.
  Submitted source is treated as executable code and must cross the container
  boundary.
- Installing arbitrary dependencies from the network during a job. The first
  runtime image is pre-built and digest-pinned; package code is mounted or
  copied into the job workspace.
- Building a public package marketplace, dependency solver, hot reload,
  provenance system or general Python sandbox in this initiative.
- Removing or silently changing the legacy NNTree API while package jobs are
  introduced.

## Decisions and invariants

- `DiagramCore` remains the only authority for the live graph. The MCP server,
  transport layer and backend must not create a competing mutable graph.
- Package identity is always `{id, version, name}`. The backend resolves by
  exact ID/version and validates the manifest; display names never select code.
- The frontend package host continues to use Cordis for package lifecycle,
  registration and cleanup. New TypeScript transport/export services should
  be mounted in the existing context and release resources through
  `ctx.effect()`/fiber disposal. Cordis is a lifecycle/dependency mechanism,
  not a Python execution sandbox or a replacement for container isolation.
  See the [Cordis context API](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/context.md)
  and [Cordis lifecycle/effects guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md).
- The Python worker owns a language-native package runtime. It must not depend
  on a JavaScript Cordis context or on the browser; the cross-language
  contract is the versioned package manifest and runtime API.
- Lua inference remains independent from backend compilation. A successful
  frontend tensor result is evidence for editor semantics, not permission to
  execute arbitrary backend code.
- Join parents are ordered by `targetHandle` (`in-0`, `in-1`, ...), and hidden
  subflow children compile exactly like visible children. A top-level graph has
  exactly one `Input`; internal subflow inputs follow the current boundary
  contract.
- Package dependency activation is deterministic and bounded. Every package
  must have a declared `pytorch` entrypoint for backend use; a package without
  one is rejected before a job is queued.
- The recommended first transport is a content-addressed, authenticated
  bundle upload followed by a job reference. The stored bundle contains
  canonical `manifest.json`, `stereotype.json` and `pytorch.py` resources for
  the selected dependency closure. The server computes the digest; the client
  cannot select a filesystem path or inject an import path.
- Package jobs use a new discriminated network format (proposed name
  `package`) while `nntree` remains supported. No legacy payload is silently
  reinterpreted as a package graph.
- The first execution policy is administrator-approved/bundled packages,
  offline by default, with a pre-built runtime image selected by immutable
  digest. Arbitrary package uploads, network-enabled jobs and external
  dependency installation remain explicit decisions rather than implied
  capabilities.
- Every package job runs in a short-lived container with a read-only input
  workspace, a narrowly scoped writable artifact directory, no host network by
  default, dropped capabilities, `no-new-privileges`, PID/CPU/RAM/time limits,
  and an explicit GPU device policy. The backend control-plane container is
  not the job sandbox.
- Pairing and `connection_id` ownership apply equally to bundle uploads, jobs,
  logs, events and generated model packages. Secrets never enter the bundle or
  logs.
- Current knowledge documents describe the present system. They are updated
  only after the user accepts the open decisions and an implementation changes
  the corresponding contracts; this draft does not make those decisions
  authoritative.

## Open decisions to confirm before implementation

| Topic | Recommended first choice | Why it matters |
| --- | --- | --- |
| Package trust | Only bundled or administrator-approved package digests | Frontend-delivered Python is executable code; a digest/allowlist is stronger than trusting the browser. |
| Upload shape | Authenticated streamed archive, content-addressed and referenced by job | Avoids large base64 JSON, enables reuse and verifies one immutable byte sequence. |
| Container granularity | One short-lived container per job | Gives failure and resource isolation while keeping the control plane long-lived. |
| Dataset source | Pre-installed/registered backend datasets or explicitly mounted operator volumes | The browser must not turn an arbitrary path or Python target into host access. |
| Network policy | Disabled during execution; opt-in operator policy only | Prevents package code and datasets from exfiltrating secrets or installing code. |
| GPU scope | CPU first, then an explicit CUDA image/device contract | GPU passthrough differs between rootless Podman, Docker and Slurm and needs a separate acceptance path. |
| Legacy jobs | Keep `nntree` as a parallel format during migration | Existing clients and tests depend on the current backend contract. |

If any recommendation changes, update this plan before task execution. No
choice above should be promoted to `docs/knowledge/decisions/` merely because
it appears in this draft.

## Contracts and control flow

### Proposed package bundle

The canonical bundle is an immutable transport artifact, not a second live
graph. Its logical contents are:

```text
package-bundle/v1
├── bundle.json                 # schema, digest inputs, runtime contract
├── graph.json                  # semantic nodes, params, parentId, edges/handles
└── packages/
    └── <id>/<version>/
        ├── manifest.json
        ├── stereotype.json
        └── pytorch.py
```

`graph.json` excludes layout and other presentation fields from the compiler
contract but retains containment and all handle IDs. `bundle.json` records the
exact package closure, runtime contract version, byte sizes and SHA-256
digests. Archive paths are normalized and validated; symlinks, duplicate
entries, path traversal and undeclared resources are rejected.

### Proposed job flow

```text
DiagramCore + Cordis package host
    -> collect exact package closure and build canonical bundle
    -> authenticated upload, digest/allowlist validation
    -> POST /jobs {network: {format: package, bundle_ref, graph}}
    -> JobManager / Valkey ownership + priority/FIFO
    -> ContainerExecutor(engine=podman|docker)
    -> pinned PyTorch worker image
    -> Python package registry -> graph compiler -> training/inference
    -> logs/events/artifacts -> verified model package download
```

The package worker loads modules under a generated, non-colliding namespace,
injects the repository-owned `stereotype_runtime.pytorch` contract, and calls
`build()` only after validating package identity, parameters, dependency
closure, graph topology and runtime compatibility. `StereotypeServices` and
`SubflowServices` are explicit interfaces for dynamic references and nested
composition. The worker never evaluates Lua and never asks the frontend for
semantic types during execution.

### Compatibility boundary

`NetworkPayload` becomes a discriminated union with the existing `nntree`
variant and a new `package` variant. `JobManager` keeps the current NNTree
configuration path and dispatches package jobs to the package compiler/worker.
The executor protocol remains the scheduling seam, but the package path must
not reuse `LocalExecutor`'s host-Python command. The model-package exporter
must either consume the package runtime's resolved architecture or explicitly
document a separate package-job artifact schema; it must continue to verify
weights and wheel digests before download.

## Task graph

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [`T01`](tasks/T01-contract-and-trust.md) | `architecture` | — | — | `docs/plans/active/package-pytorch-backend/tasks/T01-contract-and-trust.md` | Accepted package protocol, trust policy and open-decision record. |
| [`T02`](tasks/T02-frontend-package-export.md) | `frontend` | `T01` | `T03` | `front-end/src/type-system/`, `front-end/src/training/`, frontend tests | Deterministic package bundle export using the Cordis-owned catalog. |
| [`T03`](tasks/T03-python-package-runtime.md) | `backend` | `T01` | `T02` | `converted/src/stereotype_runtime/`, `converted/src/package_runtime/`, Python tests | Package loader, runtime services and graph compiler. |
| [`T04`](tasks/T04-package-job-api.md) | `backend` | `T01`, `T03` | `T02` | `converted/src/backend/`, backend tests | Authenticated bundle storage and versioned package-job lifecycle. |
| [`T05`](tasks/T05-container-executor.md) | `operations` | `T03`, `T04` | — | `converted/backend/`, `converted/src/backend/executors/`, worker entrypoint, ops tests | Podman/Docker-compatible per-job execution with explicit limits. |
| [`T06`](tasks/T06-training-ui-flow.md) | `frontend` | `T02`, `T04` | `T05` | `front-end/src/training/`, `front-end/src/components/`, frontend tests | User-visible submit, status, logs, cancellation and artifact flow. |
| [`T07`](tasks/T07-cross-boundary-verification.md) | `integration` | `T05`, `T06` | — | `converted/src/tests/`, `front-end/src/__tests__/`, evidence | One valid package graph runs end to end and security/compatibility gates pass. |
| [`T08`](tasks/T08-knowledge-and-operations.md) | `documentation` | `T07` | — | `docs/knowledge/`, `docs2/source/`, `converted/backend/README.md` | Current contracts and Podman/Docker operations match the shipped behavior. |

## Integration and review gates

- T01 must settle the bundle schema, trust policy, package runtime version and
  CPU/container acceptance path before implementation begins.
- T02 and T03 must agree on one canonical manifest/resource representation;
  neither may add package-ID dispatch tables or a second graph authority.
- T04 must preserve existing bearer auth, ownership, queue ordering, recovery,
  cancellation, SSE and `nntree` behavior.
- T05 must show the exact engine argv in tests and must never construct a shell
  command from user-controlled strings. Engine discovery, image digest,
  volume paths, GPU flags and network policy must be explicit configuration.
- No test may treat a successful PyTorch execution as proof of frontend type
  semantics; package/Lua differential and graph tests remain separate.
- Package uploads must reject malformed archives, path traversal, missing or
  duplicate package resources, undeclared dependencies, digest mismatch,
  unsupported runtime versions and oversized payloads before queueing.
- Browser and API clients must never receive backend filesystem paths as a
  requirement for submitting or downloading a job.
- Review must include the legacy `nntree` path and a valid package graph with a
  join and a nested subflow so ordering and containment are exercised.

## Acceptance criteria

- [ ] A valid package-format diagram can export its exact PyTorch package
      closure and submit an authenticated package job.
- [ ] The backend loads only declared, validated package entrypoints and builds
      the graph through the shared runtime contract; Lua remains frontend-only.
- [ ] The job executes inside a short-lived, digest-pinned container selected
      through the configured Podman/Docker-compatible engine.
- [ ] CPU and memory limits, read-only inputs, writable artifact scope, network
      default, timeout/cancellation and log collection are observable in tests
      and operator documentation.
- [ ] A successful package job produces a verifiable artifact/model package;
      the existing SHA-256 download checks still hold.
- [ ] Existing NNTree jobs, auth ownership, Valkey queue semantics and current
      frontend package inference remain green.
- [ ] No unaccepted open decision is hidden as a permanent implementation
      assumption.

## Final verification

Run from the repository root unless noted otherwise:

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end guard:package-only
cd converted && uv run pytest src/tests/ -m fast -q
git diff --check
```

For the final package path, add the smallest real-interface smoke test that
uploads one valid bundle, submits one CPU job, observes SSE terminal state,
reads logs and verifies the produced artifact. Run the engine-specific smoke
test for the configured Podman command and a Docker-compatible command when
available; if GPU support is deferred, record that explicitly rather than
claiming GPU verification.

## Knowledge and archive impact

- After the open decisions are accepted, add a durable decision under
  `docs/knowledge/decisions/` for the package backend trust and container
  boundary, then link it from the package type-system and remote-training
  contracts.
- Update `docs/knowledge/architecture/overview.md`,
  `docs/knowledge/architecture/remote-training.md`,
  `docs/knowledge/contracts/package-type-system.md` and the relevant testing
  strategy only when implementation makes their current statements false.
- Update `docs/knowledge/operations/local-stack.md` and the backend/admin
  documentation with the selected engine, image digests, socket/runner
  security model, volumes, resource policy and cleanup commands.
- Preserve this plan's evidence and move it to
  `docs/archive/completed-plans/` only after all acceptance criteria pass.
