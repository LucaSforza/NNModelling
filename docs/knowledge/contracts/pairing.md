---
kind: knowledge
status: current
updated: 2026-08-12
---

# Pairing and job ownership

Remote-training identity is an administrator-approved browser connection, not a
user account. The contract is intended for a trusted LAN and is not sufficient
for direct Internet exposure.

## Trust model

- A new browser requests pairing and receives a high-entropy opaque token plus
  a short verification code.
- An administrator approves or rejects the request through protected backend
  commands/API.
- Valkey stores a token digest, not the plaintext token.
- The token is a bearer capability and must not appear in URLs or logs.
- Jobs belong to `connection_id`; authorization is enforced by the backend on
  every job, log, event and package operation.
- IP address, device name, Origin and user agent are descriptive metadata, not
  authentication factors.

Pairing requests transition through:

```text
pending -> approved | rejected | expired
```

Connections transition through active, expired and revoked states. An approved
renewal preserves the connection identity and therefore job ownership; a new
pairing after revocation creates a new identity.

## API boundary

Public unauthenticated access is limited to health and pairing. Protected
requests use a bearer token. Administrative pairing routes additionally require
the configured admin token and are hidden from the public API schema.

The frontend persists its backend URL and token locally, verifies the session
on reuse, and distinguishes local forgetting from server-side revocation.

## Security boundary

Pairing prevents anonymous job access but does not make arbitrary Hydra or
NNTree input safe. Target allowlists, resource limits, rate limits, isolation,
TLS and Internet deployment hardening remain separate concerns. Historical
gaps from the closed issue #14 are archived in
[`issue-14-remaining-work.md`](../../archive/reports/remote-training-backend/issue-14-remaining-work.md)
and require reassessment before any new active plan is created.

Principal implementation: `converted/src/backend/auth.py`,
`converted/src/backend/app.py`, `converted/src/backend/store.py`, and
`front-end/src/training/api.ts`.
