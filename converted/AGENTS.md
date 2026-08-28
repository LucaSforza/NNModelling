# Python package backend guidance

Applies to `converted/`. Inherit repository-wide rules from `../AGENTS.md`.

## Stack and commands

Use Python style, testing and PyTorch repository skills when their trigger
conditions apply. Run commands from `converted/`:

```bash
uv run pytest src/tests/ -m fast -q
```

The supported backend path is package-native: package bundles are validated by
FastAPI, queued by the Valkey-backed scheduler and run by a Podman/Docker
worker. The host process must not import or execute uploaded package Python.

## Package contracts

- `DiagramCore` is the browser authority for package graphs.
- Package definitions and resources are immutable and authenticated.
- The compiler produces prediction and objective programs sharing one module
  store; targets enter only through the typed dataset batch boundary.
- A prediction wheel contains its graph, package resources, input adapter and
  safetensors weights and is usable without this checkout.
- Training requests are typed; free-form configuration overrides are not part
  of the public contract.

## Backend invariants

Preserve authentication, package ownership, immutable bundle storage,
priority/FIFO scheduling, heartbeats, cancellation, recovery, SSE/log cursors
and worker-container isolation. Podman and Docker are supported through the
container controller. There is no host-Python fallback for package jobs.

Use focused pytest files while iterating, then run the fast suite. Exercise the
public API and a representative worker-container path when changes cross those
boundaries. Apply `../.agents/skills/verify-task/SKILL.md` before final handoff.

Current contracts are documented in
`../docs/knowledge/architecture/remote-training.md` and
`../docs/knowledge/contracts/model-package.md`.
