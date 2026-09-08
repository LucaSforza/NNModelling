---
kind: knowledge
status: current
updated: 2026-09-08
---

# Local development stack

Use package scripts and the repository browser/MCP skills instead of rebuilding
process lifecycle commands manually.

## Editor and MCP

```bash
pnpm --dir front-end dev
pnpm --dir mcp-server test
pnpm --dir mcp-server start
```

Browser-backed MCP additionally needs Chromium with remote debugging and the
WebSocket listener, normally on port 9339. Follow
`.agents/skills/nnmodelling-mcp/SKILL.md` and its `scripts/nnm-stack.sh`
helper. Direct browser work follows `.agents/skills/chrome-direct/SKILL.md`.

## Remote-training backend

From `converted/`, run persistent Valkey and FastAPI with `PYTHONPATH=src` and
`NNM_VALKEY_URL` pointing to the selected local Valkey database. Deployment
configuration is under `converted/backend/`; the persistent container path is
`converted/backend/docker-compose.yml`. Rootless Podman is the standard local
engine, so use `podman compose` on this host. Docker Compose remains a
compatible alternative only when the selected engine and socket configuration
are explicitly adjusted.

### Persistent backend Compose

The standard repository-root entrypoint is:

```bash
just --justfile converted/backend/justfile compose
```

It builds the worker first, derives an immutable digest reference, starts the
rootless Podman socket, and starts the `valkey`, `controller`, and `backend`
services in the `nnm-backend` Compose project. The backend service uses
`--unsafe-unlimited-dataset-size`; file-count and archive-safety checks still
apply. The controller is the only service mounted with the host Podman socket;
FastAPI reaches it through the authenticated `controller-socket` volume.

The Compose file deliberately binds the host job, dataset, data, Valkey and
token paths because worker containers are created by host Podman and must see
the same paths. `NNM_CONTAINER_IMAGE` is required and must be a digest-pinned
worker image. The standard `just compose` recipe supplies the required
`NNM_HOST_VALKEY_DATA`, `NNM_HOST_JOBS`, `NNM_HOST_DATA`,
`NNM_HOST_ADMIN_TOKEN`, and `NNM_HOST_CONTROLLER_TOKEN` values.

For non-standard paths, dataset limits, Origins, engine settings, or W&B
settings, the backend administrator should invoke `podman compose` directly
with explicit `NNM_*` variables rather than using the standard `just compose`
wrapper. Validate expansion before a start:

```bash
podman compose --project-name nnm-backend \
  -f converted/backend/docker-compose.yml config
podman compose --project-name nnm-backend \
  -f converted/backend/docker-compose.yml up --build -d
```

The W&B network and allowlisting proxy are operator-managed external
dependencies; Compose only passes their configured name and URL to the
controller. The W&B credential file is mounted read-only into the controller
and must remain owner-only. Never put tokens or API keys in the Compose file,
command line, or logs. Stop the deployment with `podman compose ... down`
without `--volumes`, because persistent Valkey and job state are host-mounted.

Important configuration boundaries include:

- `NNM_BACKEND_ARTIFACT_ROOT`: persistent job artifacts;
- `NNM_VALKEY_URL`: control-plane storage;
- Slurm enablement, account, partition, SSH host and capacity variables;
- admin and pairing TTL configuration;
- optional backend bearer token for the MCP remote-training client.

Start FastAPI through `PYTHONPATH=src uv run python -m backend.cli`. Dataset
archive limits use the documented CLI options in `converted/README.md`; the
justfile also provides `backend-unsafe-unlimited-dataset-size` for the explicit
unsafe mode. Do not use that mode on an untrusted or resource-constrained host.

Do not expose Valkey to the LAN. The pairing contract assumes a trusted LAN and
does not authorize direct Internet exposure.

## Cleanup and diagnostics

- Inspect listeners before starting duplicate frontend, backend, Valkey,
  Chromium or MCP processes.
- Prefer graceful helper shutdown over killing by broad process pattern.
- Keep screenshots and transient job artifacts under `/tmp` unless a repository
  artifact is explicitly requested.
- Do not remove job artifacts or persistent Valkey data without explicit user
  authorization.
