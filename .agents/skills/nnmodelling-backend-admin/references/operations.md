# Backend operations

Run commands from the repository root unless a command explicitly changes
directory. Treat `converted/backend/justfile` as authoritative if this reference
and the code diverge.

## Topology and ports

The normal local training path has three backend processes:

```text
browser/MCP -> FastAPI :8000 -> Valkey :6379
                         |
                         `-> authenticated Unix socket -> container controller
                                                        -> one worker per job
```

The editor normally runs at `http://127.0.0.1:5174` and the browser-backed MCP
bridge at `9339`. These are not backend processes; use the
`nnmodelling-mcp` skill for their lifecycle.

Before startup, run:

```bash
.agents/skills/nnmodelling-mcp/scripts/nnm-stack.sh status
just --justfile converted/backend/justfile container-config
```

Inspect an occupied port and its owning PID before stopping anything. A healthy
listener owned by the current workflow should be reused.

## Local foreground workflow

Keep each process in a persistent terminal.

```bash
# Terminal 1: persistent control plane
just --justfile converted/backend/justfile valkey

# Terminal 2: trusted engine boundary
just --justfile converted/backend/justfile controller

# Terminal 3: bounded FastAPI backend
NNM_CONTAINER_IMAGE='registry/name@sha256:<64-hex-digest>' \
NNM_ALLOWED_ORIGINS='http://127.0.0.1:5174' \
just --justfile converted/backend/justfile backend
```

Podman is the default engine. Set `NNM_CONTAINER_ENGINE=docker` consistently on
the controller and backend to use Docker or a compatible wrapper. FastAPI owns
the worker-image selection and sends it to the controller; the image must exist
locally or be pullable and must be referenced by digest.

`backend` runs `admin-init`, creating the untracked owner-only admin token when
needed. It does not start Valkey or the controller.

Verify:

```bash
just --justfile converted/backend/justfile health
just --justfile converted/backend/justfile sessions
just --justfile converted/backend/justfile admin-jobs
```

## Dataset-size variants

### Default bounded mode

Use `backend`. Defaults are 64 MiB compressed, 16 MiB per file, 64 MiB total
expanded, and 2048 files.

### Finite custom limit

Initialize the admin token, then use the backend CLI with a finite limit. The
value applies to the compressed archive, each file, and total expanded bytes.

```bash
just --justfile converted/backend/justfile admin-init
cd converted
NNM_CONTAINER_IMAGE='registry/name@sha256:<64-hex-digest>' \
PYTHONPATH=src uv run python -m backend.cli \
  --host 127.0.0.1 --port 8000 --max-dataset-size 256MiB
```

Accepted suffixes are `B`, `KiB`, `MiB`, and `GiB`. The legacy
`NNM_DATASET_MAX_ARCHIVE_BYTES` changes only the compressed limit; prefer the
explicit CLI option when one uniform finite limit is intended.

### Unsafe unlimited byte size

Use only when the user explicitly requires unbounded dataset bytes and the
host has appropriate resource controls:

```bash
NNM_CONTAINER_IMAGE='registry/name@sha256:<64-hex-digest>' \
just --justfile converted/backend/justfile backend-unsafe-unlimited-dataset-size
```

This disables compressed, per-file, and total-expanded byte limits. It does not
disable the 2048-file limit, ZIP/path safety, metadata validation, ownership,
digest verification, or atomic publication. Verify the authenticated
capabilities report shows `max_bytes: null`. This mode can exhaust RAM, disk,
and decompression resources.

`--max-dataset-size` and `--unsafe-unlimited-dataset-size` are mutually
exclusive.

## Persistent Compose workflow

Use the checked-in Compose deployment when persistence and restart management
are wanted:

```bash
NNM_CONTAINER_IMAGE='registry/name@sha256:<64-hex-digest>' \
NNM_ALLOWED_ORIGINS='http://127.0.0.1:5174' \
just --justfile converted/backend/justfile docker-up

just --justfile converted/backend/justfile docker-down
```

`docker-down` preserves named volumes. Do not add `--volumes` unless deletion
is explicitly requested. Configure engine socket paths and UID-sensitive
rootless Podman settings for the host; never expose the socket over an
unprotected TCP endpoint.

## LAN binding

For a trusted LAN client, bind FastAPI deliberately and allowlist the exact
frontend Origin:

```bash
NNM_BACKEND_HOST=0.0.0.0 \
NNM_ALLOWED_ORIGINS='http://192.168.1.30:5174' \
just --justfile converted/backend/justfile backend
```

`NNM_ALLOWED_ORIGINS` is comma-separated. Include every actual scheme, host,
and port used by browsers; `localhost` and `127.0.0.1` are different Origins.
Do not use a wildcard. Plain HTTP does not protect bearer tokens outside a
trusted local network.

## Pairing and sessions

The browser initiates pairing. The administrator approves the displayed
request, optionally with a bounded TTL:

```bash
just --justfile converted/backend/justfile pairing-pending
just --justfile converted/backend/justfile pairing-approve REQUEST_ID
just --justfile converted/backend/justfile pairing-approve REQUEST_ID 8h
just --justfile converted/backend/justfile pairing-reject REQUEST_ID
just --justfile converted/backend/justfile sessions
just --justfile converted/backend/justfile session-revoke CONNECTION_ID
```

Approve only a request whose device name, Origin, and short code match the
user's browser. Those fields are descriptive; the bearer token is the actual
capability. Renewal preserves job ownership; a new pairing creates a distinct
owner identity.

## W&B modes

Disabled and offline require no egress or credential. Online uses one
administrator-owned account.

Configure the credential interactively; never place the key in argv:

```bash
just --justfile converted/backend/justfile wandb-connect ENTITY
just --justfile converted/backend/justfile wandb-status
```

For self-hosted W&B, pass its API base URL as the second argument. The command
authenticates before atomically writing an owner-only `0600` file.

Online mode also requires all controller settings:

```bash
NNM_WANDB_CREDENTIAL_FILE='/secure/path/wandb-credentials.json' \
NNM_WANDB_NETWORK='nnm-wandb-egress' \
NNM_WANDB_PROXY_URL='http://wandb-proxy.internal:3128' \
just --justfile converted/backend/justfile controller
```

The named network and proxy are operator-managed; NNModelling does not create
them. The network must deny direct egress and permit only the proxy. Proxy URLs
with embedded credentials are rejected. Verify the authenticated capability
reports `online.configured: true`, a sanitized entity/base URL, and no reason.

Disconnect only when explicitly requested:

```bash
just --justfile converted/backend/justfile wandb-disconnect
```

## Job administration

```bash
just --justfile converted/backend/justfile admin-jobs
just --justfile converted/backend/justfile admin-job JOB_ID
just --justfile converted/backend/justfile admin-job-logs JOB_ID
just --justfile converted/backend/justfile admin-job-cancel JOB_ID
```

Prefer browser/MCP cursor-based progress for user-owned live jobs. Use admin
commands for cross-session diagnosis. Cancellation is destructive to active
work; inspect status and heartbeats first.

## User-facing training verification

When backend work is meant to enable NNModelling training, process health alone
is insufficient. Through the selected browser editor:

1. validate the graph and typed parameters;
2. connect/pair and inspect training capabilities;
3. submit with `start_training`;
4. monitor with `read_editor_training_progress`, carrying all cursors/offsets;
5. require terminal `succeeded`, no diagnostics, expected epochs, and a model
   package manifest;
6. download with `download_editor_training_wheel` and smoke-test the public
   model API.

Keep compatibility HTTP-client MCP tools separate from selected-editor tools;
they do not share connection ownership.
