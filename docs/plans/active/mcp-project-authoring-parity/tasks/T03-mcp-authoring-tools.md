---
id: T03
kind: task
status: done
plan: ../plan.md
role: integration
depends_on: [T01]
parallel_with: [T02]
write_scope:
  - mcp-server/
---

# Expose project authoring through MCP

## Objective

Register four accurately typed MCP tools that validate JSON transport and proxy
the accepted requests to the selected browser tab.

## Context required

Read the plan and browser-MCP architecture. Inspect tool discovery/dispatch,
existing project and graph tool patterns, browser client, and MCP tests.

## Invariants

- Tools are thin adapters and keep no catalog, generator or project graph.
- Schemas expose every semantic UI request field with correct JSON types.
- Dataset data files use strict `{path, dataBase64}` JSON transport.
- Delete uses exact `{id, version, path}`; browser owns eligibility and domain
  validation.

## Allowed files

Any file under `mcp-server/`, limited to tool registration/schema and tests.

## Out of scope

Frontend code, direct project-file authoring, backend calls, dataset update,
rename/move or compatibility-tool removal.

## Work

1. Add `create_stereotype`, `delete_stereotype`, `create_dataset`, and
   `delete_dataset` tool schemas/handlers.
2. Reuse tool discovery and selected-tab BrowserRPCClient forwarding.
3. Add schema and proxy regression tests, including malformed base64/identity.
4. Defer test execution to T05.

## Acceptance criteria

- [x] Four tools appear through normal discovery.
- [x] Valid payloads are forwarded unchanged except documented JSON transport.
- [x] Invalid JSON shapes fail before browser mutation.
- [x] Browser/domain failures remain visible.
- [x] No changes outside `mcp-server/`.

## Validation

Executed during T05:

```bash
pnpm --dir mcp-server test
```

The TypeScript build succeeded and all 74 MCP tests passed.

## Required handoff

Handoff completed; T04 reviewed the cross-boundary contract and T05 passed final
automated and live-interface QA.
