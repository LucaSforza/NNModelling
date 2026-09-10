---
kind: knowledge
status: current
updated: 2026-09-10
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

## Electron and Flatpak editor

The Linux Flatpak is a desktop shell around the same production frontend. It
does not bundle FastAPI, Valkey, Podman/Docker, worker images or training jobs;
training remains an authenticated connection to an operator-managed backend.
The desktop renderer has the exact origin `app://nnmodelling`. Keep that origin
in `NNM_ALLOWED_ORIGINS` together with the origins used by web editors:

```bash
NNM_ALLOWED_ORIGINS=http://127.0.0.1:5174,http://localhost:5174,app://nnmodelling \
just --justfile converted/backend/justfile backend
```

From a source checkout, build the frontend and desktop host, then use the
Flatpak manifest to install a local build:

```bash
pnpm install --frozen-lockfile
pnpm --dir front-end build
pnpm --dir desktop build
flatpak-builder --force-clean --user --install-deps-from=flathub \
  --repo=repo --install builddir \
  io.github.LucaSforza.NNModelling.yml
flatpak run io.github.LucaSforza.NNModelling
flatpak build-bundle repo NNModelling.flatpak \
  io.github.LucaSforza.NNModelling \
  --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo
```

Project directories are selected through the desktop portal bridge; the
Flatpak must not be granted blanket home-directory access. Browser users keep
using the File System Access API and the existing Pages/development commands.

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
secret paths because worker containers are created by host Podman and must see
the same paths. Tokens and W&B credentials live under the owner-only
`converted/backend-secrets/` directory, separate from `valkey-data/`; the
Valkey image may change ownership of its data directory during startup.
`NNM_CONTAINER_IMAGE` is required and must be a digest-pinned worker image. The
standard `just compose` recipe supplies the required
`NNM_HOST_VALKEY_DATA`, `NNM_HOST_JOBS`, `NNM_HOST_DATA`,
`NNM_HOST_ADMIN_TOKEN`, and `NNM_HOST_CONTROLLER_TOKEN` values.

The rootless Podman deployment uses `userns_mode: keep-id` so the non-root
controller process retains access to the invoking user's socket and owner-only
secret files. SELinux labeling is disabled only for the trusted controller
container that holds the host-administrator socket capability. Its healthcheck
requires both the authenticated controller socket and a successful Podman API
request; a present controller socket alone is not considered healthy.

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
