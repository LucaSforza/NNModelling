# NNModelling Training Backend

The FastAPI backend receives compiled networks, persists a priority queue in
Valkey, and executes training locally or through Slurm. Browser access requires
administrator-approved pairing; jobs, logs, events, and cancellation are
isolated by connection owner.

This release is intended for a trusted LAN. Do not expose FastAPI, Valkey, or
the administrator token directly to the Internet. Plain HTTP does not encrypt
browser bearer tokens.

## Local start

From the repository root, use the backend justfile:

```bash
# Terminal 1
just --justfile converted/backend/justfile valkey

# Terminal 2: local browser only
just --justfile converted/backend/justfile backend

# LAN example
NNM_BACKEND_HOST=0.0.0.0 \
NNM_ALLOWED_ORIGINS=http://192.168.1.30:5174 \
just --justfile converted/backend/justfile backend
```

`backend` creates an untracked `valkey-data/admin.token` with mode `0600` when
needed. Approve the code displayed by the frontend:

```bash
just --justfile converted/backend/justfile pairing-pending
just --justfile converted/backend/justfile pairing-approve REQUEST_ID
just --justfile converted/backend/justfile pairing-approve REQUEST_ID 8h
```

Common administration:

```bash
just --justfile converted/backend/justfile sessions
just --justfile converted/backend/justfile session-revoke CONNECTION_ID
just --justfile converted/backend/justfile admin-jobs
just --justfile converted/backend/justfile admin-job JOB_ID
just --justfile converted/backend/justfile admin-job-logs JOB_ID
just --justfile converted/backend/justfile admin-job-cancel JOB_ID
just --justfile converted/backend/justfile test
```

## Docker

```bash
just --justfile converted/backend/justfile docker-up
just --justfile converted/backend/justfile docker-down
```

Compose persists Valkey and job artifacts. The admin token is generated on the
host and mounted read-only into the backend container. Configure the exact
allowed frontend Origins before admitting LAN clients.

## Documentation

The official Sphinx documentation contains two dedicated pages:

- `docs2/source/training_user_guide.rst` — connect, pair, train, renew, and
  disconnect from the frontend;
- `docs2/source/training_admin_guide.rst` — workstation, Docker, and Slurm
  installation, configuration, pairing, revocation, and job operations.

Historical remaining-work notes from the closed issue #14 are archived under
`docs/archive/reports/remote-training-backend/`. Current architecture and
reassessment guidance live in `docs/knowledge/architecture/remote-training.md`.

The MCP browser/diagram server remains usable, but its remote-training HTTP
client does not perform pairing or token renewal. Supply an operator-managed
bearer token with `NNM_BACKEND_TOKEN` when pointing it at the protected backend.
