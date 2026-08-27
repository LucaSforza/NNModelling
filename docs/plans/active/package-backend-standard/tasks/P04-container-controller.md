---
id: P04
kind: task
status: ready
plan: ../plan.md
role: operations
depends_on: [P01, P03]
write_scope:
  - converted/src/backend/executors/
  - converted/src/backend/container_controller.py
  - converted/src/tests/
  - converted/backend/
---

# Add the least-privilege Podman/Docker controller

Implement a separate trusted `ContainerController` process with a local
authenticated Unix-socket protocol. FastAPI sends only a server-generated,
validated `ContainerJobSpec`; the controller owns the narrow engine capability
and reports start, heartbeat, logs, timeout, cancellation and exit state.

Provide Podman and Docker adapters behind the same argv/spec contract. Use
rootless engines by default, digest-pinned images, read-only input/rootfs,
one writable artifact mount, dropped capabilities, `no-new-privileges`, default
seccomp/MAC policy, no network, no devices and explicit CPU/RAM/PID/time/output
limits. Do not expose an engine socket inside the worker.

Reject unavailable capabilities at submission or with a typed terminal error;
never requeue forever and never fall back to host Python.

Acceptance: fake-engine tests assert the complete command and mount policy;
real CPU smoke tests pass for Podman and Docker where installed.

Validation:

```bash
cd converted && uv run pytest src/tests/test_container_controller.py src/tests/test_container_executor.py -q
```
