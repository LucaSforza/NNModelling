---
name: nnmodelling-backend-admin
description: Operate, configure, verify, and troubleshoot the NNModelling package-training backend, including Valkey, the FastAPI service, the Podman/Docker controller, browser pairing, dataset limits, worker images, jobs, and W&B connectivity. Use for backend lifecycle or incidents; do not use for diagram editing alone.
---

# NNModelling backend administration

Keep the package-training backend available without weakening its trust
boundaries. Prefer the checked-in `converted/backend/justfile` over reconstructed
commands, and inspect the live state before starting, restarting, cancelling, or
reconfiguring anything.

## Read before acting

1. Read the repository `AGENTS.md` and `converted/AGENTS.md`.
2. Read `converted/backend/justfile`; it is the command-level authority.
3. Read `converted/README.md` and
   `docs/knowledge/architecture/remote-training.md` when configuration or
   security boundaries matter.
4. For startup modes, pairing, W&B, and administrative commands, read
   [references/operations.md](references/operations.md).
5. For an incident or failed job, read
   [references/troubleshooting.md](references/troubleshooting.md).
6. When the task also touches the live editor, browser-backed MCP, project
   loading, training submission, or artifact download, load
   `../nnmodelling-mcp/SKILL.md` and use its selected-editor workflow.

## Non-negotiable architecture

- The browser `DiagramCore` owns live diagram state. The backend owns
  authenticated package bundles, datasets, jobs, and artifacts.
- FastAPI must never import or execute uploaded package Python. Exactly one
  short-lived worker container executes each package job.
- Valkey is the persistent control plane for pairing, ownership, scheduling,
  heartbeats, cancellation, recovery, and event/log cursors.
- Only the trusted container controller may access the Podman/Docker socket.
  Treat that socket as host-administrator authority.
- Worker images must be immutable digest references. Never silently use a
  mutable tag or a host-Python fallback.
- When code or dependencies executed by the worker change, run
  `just --justfile converted/backend/justfile worker-build`, then restart
  FastAPI with the printed `NNM_CONTAINER_IMAGE` digest. Restarting a backend
  alone deliberately preserves its previously configured worker image.
- Disabled and offline W&B jobs use `--network none` and receive no credential.
  Online jobs require an operator-managed egress network, allowlisting proxy,
  and owner-only credential file delivered to the worker over stdin.
- Browser bearer tokens, administrator tokens, controller tokens, and W&B API
  keys must not appear in commands, URLs, logs, chat, Git, or artifacts.
- Do not expose FastAPI, Valkey, or the administrator token directly to the
  Internet. The documented plain-HTTP deployment is for localhost or a trusted
  LAN only.

## Administration loop

1. **Observe.** Check the shared NNModelling stack, expected listeners, backend
   health, controller/engine configuration, and current jobs. Reuse healthy
   services; do not create duplicate listeners.
2. **Choose the supported mode.** Decide local foreground versus persistent
   Compose, bounded versus finite custom versus unsafe-unlimited dataset size,
   Podman versus Docker, and W&B disabled/offline versus online. Do not combine
   mutually exclusive dataset-limit modes.
3. **Start only missing components.** The local training path needs Valkey,
   controller, and FastAPI as separate long-lived processes. Keep foreground
   commands in persistent terminals or use the Compose lifecycle.
4. **Verify the contract, not only the process.** Require backend health, a
   usable digest-pinned worker, correct browser Origin/pairing, expected
   capabilities, and a representative selected-editor operation when the task
   includes training.
5. **Diagnose from evidence.** Preserve job IDs, timestamps, status,
   heartbeats, bounded log offsets, and sanitized capability reasons. Fix the
   narrowest failed boundary; do not restart every component as a first move.
6. **Finish safely.** Confirm terminal job state and artifacts, report only
   sanitized configuration, and leave unrelated services and user changes
   untouched.

## Persistent Podman Compose deployment

`converted/backend/docker-compose.yml` is the supported single-file
instantiation for the persistent local backend. On this machine use Podman:
`podman compose`, not `docker compose`. The file starts Valkey, the FastAPI
service, and the trusted container controller; it does not create the
operator-managed W&B egress network or proxy. Those must already exist when
online W&B jobs are enabled.

The standard path is:

```text
just --justfile converted/backend/justfile compose
```

That recipe builds the worker first, obtains its immutable image digest, starts
the rootless Podman socket, and passes the host paths required by the backend
and controller. It uses the unsafe-unlimited dataset-size mode and localhost
Origins from the Compose defaults. Do not put tokens or W&B keys in the
command line or Compose file.

For a non-standard user requirement, the backend administrator should execute
`podman compose` directly instead of using `just compose`, explicitly setting
the needed `NNM_*` variables. At minimum, validate the expanded file before
starting it:

```text
podman compose --project-name nnm-backend \
  -f converted/backend/docker-compose.yml config
podman compose --project-name nnm-backend \
  -f converted/backend/docker-compose.yml up --build -d
```

The required host-path variables are `NNM_HOST_VALKEY_DATA`, `NNM_HOST_JOBS`,
`NNM_HOST_DATA`, `NNM_HOST_ADMIN_TOKEN`, and
`NNM_HOST_CONTROLLER_TOKEN`; `NNM_CONTAINER_IMAGE` must be a digest-pinned
worker reference. Use `NNM_WANDB_CREDENTIAL_FILE`, `NNM_WANDB_NETWORK`, and
`NNM_WANDB_PROXY_URL` only for the already-configured W&B integration. The
controller is the only Compose service that receives the Podman socket; the
backend talks to it through the authenticated controller socket.

Inspect without changing state with `podman compose ... ps` and stop the
deployment with `podman compose ... down`. Do not add `--volumes`: the Valkey
data and job directories are host-mounted persistent state.

## Authorization and stopping rules

Read-only health, status, capability, job, session, process, socket, image, and
log inspection is normal administration. Starting missing services and applying
the user-selected configuration are normal implementation steps.

Before cancelling a job, revoking a session, disconnecting W&B, replacing a
credential, deleting data, removing containers/networks/volumes, or stopping a
service of uncertain ownership, resolve the exact target and ensure the action
is explicitly in scope. Prefer recoverable operations. Never cancel a job that
still has fresh heartbeats merely because W&B finalization is slow.

Stop and ask for direction when a fix would require broader network exposure,
weaker authentication/isolation, a new external credential, destructive data
loss, or a materially different deployment topology.

## Completion evidence

For startup or repair, report:

- selected backend and dataset-limit mode;
- backend URL and exact allowed Origins, without bearer tokens;
- Valkey, controller, engine, digest-pinned worker image, and health status;
- sanitized W&B capability state when relevant;
- pairing/session state and terminal job outcome when relevant;
- tests or representative public-interface checks performed;
- operational changes versus repository changes.

If repository files changed, run the smallest focused tests, then
`cd converted && UV_CACHE_DIR=/tmp/nnmodelling-uv-cache uv run pytest src/tests/ -m fast -q`,
followed by `git diff --check`. Load `../verify-task/SKILL.md` before final
handoff.
