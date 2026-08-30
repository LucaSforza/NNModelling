---
id: T01
kind: task
status: draft
plan: ../plan.md
role: architecture
depends_on: []
parallel_with: []
write_scope:
  - docs/plans/active/mcp-use-case-parity/
  - docs/knowledge/architecture/browser-mcp.md
---

# Freeze public workflow contracts

## Objective

Resolve the remaining API choices without weakening the accepted UML workflows.

## Context required

Read the [initiative plan](../plan.md), its source links and the
[accepted UML](../../../../knowledge/uml/mcp-use-case-parity.md).

Read the plan's source-seam inventory, MCP `server.ts`, `browser-client.ts`, capture adapter, training clients and the project-workspace initiative's phase gate.

## Invariants

UML requirements are accepted; API names, routing and delivery proposals are not. Retain one graph authority, backend ownership and existing useful capabilities.

## Allowed files

- `docs/plans/active/mcp-use-case-parity/`
- `docs/knowledge/architecture/browser-mcp.md`

Directory scopes permit only changes serving this task. Narrow them to the
actual files in the handoff; do not reorganize unrelated modules.

## Out of scope

No product implementation, new transport, backend changes or unapproved tool retirement.

## Work

1. Record the exact current tools/list catalog and input/output shapes, plus the sidebar field inventory. Distinguish successful public calls from schema-only and mocked support.
2. Specify proposed new tool names, typed inputs, pending/error responses, time/size bounds and affected browser RPC methods. Capture must return a real browser image; define how MCP results deliver it.
3. Prove the supported capture interface can bind to the RPC-selected page. Record the adapter and a minimal two-tab feasibility check. If no supported facility exists, stop this slice and request the specific integration authority; do not invent host APIs.
4. Specify editor-session configuration lifetime, backend-session routing and the treatment of process-authenticated HTTP tool names. Request approval for any incompatible migration; preserve existing names/behavior meanwhile.
5. Choose an artifact delivery contract with bounded transfer, safe non-overwriting destination rules and digest evidence. Do not make credential export or enormous inline JSON the default download path.
6. Recheck project-dataset implementation before fixing dataset payloads. Keep unlanded migration work outside this initiative, then promote only unblocked tasks to ready.
7. Freeze M6's create/open schema from the actual UI form and shared project service. Resolve startup RPC routing before editor mount and the browser directory-picker/user-gesture permission handshake. No filesystem handle or independent server project loader may enter the contract.

## Acceptance criteria

- [ ] Every UML ID has a named public workflow, observable output and failure behavior.
- [ ] M6 has a feasible startup and permission flow; creation uses the UI's exact fields/defaults/validation and opening reuses its resource activation path.
- [ ] Capture feasibility, artifact transport and connection compatibility are resolved or explicitly block their owning task.
- [ ] The accepted UML and extra-tool preservation rule remain unchanged.
- [ ] No changes outside the declared write scope.

## Validation

Run from the repository root. Extend the listed tests for the new behavior;
passing unchanged proxy mocks alone is not proof of this task.

```bash
git diff --check
pnpm --dir mcp-server test
```

The MCP suite establishes a baseline, not parity. Inspect tools/list through the real server. Save the contract/feasibility findings under this initiative; do not record tokens or private session state.

## Required handoff

Return changed files, exact checks/results, observed user-facing behavior,
resolved assumptions, remaining blockers and affected KB statements. Keep
credentials out of evidence. Update this task's status in its own file; the
initiative plan owns overall status.
