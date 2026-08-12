---
kind: knowledge
status: current
updated: 2026-08-12
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
configuration is under `converted/backend/`; Docker Compose is the supported
container path.

Important configuration boundaries include:

- `NNM_BACKEND_ARTIFACT_ROOT`: persistent job artifacts;
- `NNM_VALKEY_URL`: control-plane storage;
- Slurm enablement, account, partition, SSH host and capacity variables;
- admin and pairing TTL configuration;
- optional backend bearer token for the MCP remote-training client.

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
