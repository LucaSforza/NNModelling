---
kind: decision
status: accepted
updated: 2026-08-28
---

# Package backend standard and least-privilege execution

The owner has confirmed the package-only backend direction, mandatory
Podman/Docker encapsulation for browser-supplied training code, the controller
boundary, the least-privilege policy and the migration away from NNTree backend
compatibility. The execution split between prediction and objectives is refined
by a separate accepted decision linked below.

## Decision

The package graph is the only supported backend network format. The browser
exports the semantic graph owned by `DiagramCore`; the backend executes that
graph through the package runtime and never converts it to NNTree.

The old NNTree conversion/training route is removed from the backend standard.
Its implementation may remain in Git history or in an explicitly separate
legacy tool while migration work is performed, but it is not a backend
executor, request variant, fallback, or dependency of package jobs.

The public model artifact remains one portable Python wheel. A raw checkpoint
archive is an internal worker artifact, not a second download contract.
Installed wheels may accept a consumer-supplied safetensors override for the
same packaged architecture, but the backend does not publish that override as
a separate artifact. The wheel remains complete and loads its embedded weights
when no override is supplied.

## Terminology

- **Package graph**: the semantic graph from the frontend, including exact
  package identities, primitive parameters, containment and edge handles.
- **Bundle**: an immutable transport representation containing the graph and
  its package-resource closure.
- **Model wheel**: the derived, installable inference artifact containing the
  resolved graph/runtime, package resources, adapters and safetensors.

The bundle is not a second graph authority and the wheel is not an input to the
training scheduler.

## Trust and least privilege

`pytorch.py` supplied by a browser is untrusted executable source. A digest
proves integrity of a byte sequence; it does not make that source trusted.
Browser-submitted source is therefore accepted only as data for a job and is
never imported, compiled, instantiated or `exec`-uted by FastAPI.

FastAPI may parse and validate bounded declarative data:

- bundle schema, canonical digest and archive paths;
- package identities, versions and declared dependency closure;
- graph topology, containment, handle ordering and resource limits;
- typed training configuration, dataset descriptors and opaque dataset
  references.

Python package code, project dataset code, PyTorch model construction, dataset
access and training run only in a short-lived worker container. AST inspection
is diagnostic input validation, never a sandbox.

The worker container uses the least privilege available from the selected
engine:

- rootless Podman or rootless Docker by default;
- non-root worker user;
- read-only image/root filesystem;
- read-only model bundle and resolved dataset mounts;
- one narrowly scoped writable artifact directory;
- dropped capabilities, `no-new-privileges`, default seccomp and the host's
  SELinux/AppArmor policy;
- explicit PID, CPU, memory, wall-clock and artifact-size limits;
- network disabled by default;
- no host filesystem root, credential directory, device or engine socket
  mounted into the worker.

If no controller and compatible container capability is available, the package
submission fails with a capability error before it enters the queue. It never
falls back to a host Python executor or remains queued indefinitely.

## ContainerController

FastAPI does not own a Podman/Docker socket. A separate, trusted
`ContainerController` process owns the narrow engine capability and exposes a
local authenticated Unix-socket RPC to the backend scheduler.

The controller accepts a versioned, server-generated `ContainerJobSpec` only:

- job ID and immutable input/artifact roots under configured directories;
- an allowlisted image digest;
- normalized CPU, memory, PID, timeout and network policy;
- the fixed worker entrypoint and server-resolved dataset mounts.

It rejects arbitrary engine flags, host paths, commands, image names and shell
strings. It creates, monitors, logs, times out and cancels the one container
for each job, and reports terminal state through the scheduler callback.

Podman and Docker are adapters behind this same controller contract. The v1
implementation uses the engine CLI with an argv array or an equivalent local
API, never a shell command assembled from request data. Rootless Podman is the
default operator path; rootless Docker is supported through the same spec. A
rootful engine requires an explicit operator opt-in and is documented as a
higher-privilege deployment.

## Kubernetes decision

Kubernetes is not a v1 dependency. For one backend host it adds an API server,
scheduler, RBAC, admission and cluster lifecycle without replacing the need
for container security. It is therefore overkill for the current execution
boundary and is not itself a sandbox guarantee.

The controller boundary intentionally leaves room for a future Kubernetes
executor when the product needs multi-node scheduling, autoscaling, GPU
allocation, high availability or stronger tenant separation. That executor
would consume the same validated `ContainerJobSpec`; it would not change the
package or training contracts.

## Training contract

Package jobs use a typed, versioned package-native training specification. Each
field is either normalized and applied or rejected; no field is silently
ignored. The contract covers an opaque dataset reference, declaratively typed
dataset parameters, batch size, workers, split, seed, optimizer,
objective/loss, epochs, early stopping, accelerator, W&B mode and resource
limits.

The seed is applied before model construction, dataset splitting or loader
creation. The objective receives targets through an explicit runtime contract;
loss behavior is never selected by output-shape heuristics or a package-ID
special case. The accepted compilation and target-binding model is defined by
the [prediction/objective program decision](prediction-objective-programs.md).

Built-in datasets are packaged in the trusted worker image and may use
operator-managed mounts. A project may also upload a complete dataset package
as untrusted content-addressed data. FastAPI validates its declarative contract
but never imports its Python; only the least-privilege worker loads it from a
server-resolved read-only mount. The browser cannot provide an import path or
host path. Network and W&B online mode are disabled unless the operator
explicitly enables a policy that grants only the required egress.

Project dataset ownership, named training batches and the bounded upload v1 are
defined by the
[project-owned dataset decision](project-owned-datasets.md). Large or resumable
dataset transfer is not implied by accepting browser-supplied dataset code.

## Artifact contract

The worker produces safetensors and resolved metadata as intermediate files,
then builds the portable wheel before the job can become `succeeded`. The
wheel contains the package-native runtime, vendored package resources, the
resolved semantic graph, declarative input adapters and verified weights. The
authenticated download remains `GET /jobs/{id}/package` with an SHA-256
manifest.

The `training_package` status field, `/training-package` endpoint,
`nnm-trained-package/v1` ZIP and checkout-dependent VAE consumer are removed.

## Ownership and failure semantics

Bundle content is immutable and content-addressed. Ownership is an ACL keyed
by `connection_id`, not part of the content path. An existing digest is
put-if-absent; a different owner cannot overwrite it. Unknown or unauthorized
references return a typed 404/403 response.

Validation and quota checks complete before job/artifact persistence. Invalid
submissions leave no job directory. Every job, bundle, log, event and wheel
download uses the authenticated connection ownership contract.

## Explicit non-goals

- Kubernetes deployment in the first package backend release.
- A general Python sandbox implemented with AST filtering.
- Network package installation during a job.
- A second NNTree compatibility variant in the backend API.
- A second public checkpoint-download format.
