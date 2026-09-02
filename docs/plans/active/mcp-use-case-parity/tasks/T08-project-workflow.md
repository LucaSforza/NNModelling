---
id: T08
kind: task
status: ready
plan: ../plan.md
role: integration
depends_on: [T01]
parallel_with: []
write_scope:
  - front-end/src/App.svelte
  - front-end/src/FlowCanvas.svelte
  - front-end/src/project-workspace/
  - front-end/src/sync/
  - front-end/src/__tests__/
  - mcp-server/src/server.ts
  - mcp-server/src/browser-client.ts
  - mcp-server/src/tools/
  - mcp-server/__tests__/
---

# Create and open projects through shared browser operations

## Objective

Satisfy M6: the agent creates a new project or opens an existing one with the
same domain behavior as the graphical interface.

## Context required

Read the [plan](../plan.md), the
[UML constraint](../../../../knowledge/uml/mcp-use-case-parity.md) and
[project-workspace decision](../../../../knowledge/decisions/project-workspaces-and-stereotype-authoring.md).
Inspect the startup New/Open form, ProjectWorkspaceAdapter, resource activation,
ordered project writer and browser RPC lifecycle. T01 must settle the startup
bridge and directory permission handshake first.

## Invariants

MCP remains a small proxy. Project creation, loading, validation and persistence
reuse the browser domain code; no server-side loader, mirrored graph or second
filesystem owner. Handles remain browser-private. Never overwrite an existing
project child or bypass permission/user-gesture requirements.

## Allowed files

- `front-end/src/App.svelte`, `front-end/src/FlowCanvas.svelte`: startup/lifecycle wiring only.
- `front-end/src/project-workspace/`: shared New/Open operations, reusing existing adapters.
- `front-end/src/sync/`: project-ready and pre-editor request routing.
- `mcp-server/src/server.ts`, `mcp-server/src/browser-client.ts`, `mcp-server/src/tools/`: narrow protocol adapters only.
- `front-end/src/__tests__/`, `mcp-server/__tests__/`: project workflow and transport coverage.

## Out of scope

New project storage formats, stereotype/dataset authoring, general remote
filesystem access, credential/handle export or replacing File System Access.

## Work

1. Add public-interface regression tests for create/open, with an initial tab
   that has not mounted an editor. The MCP path mode accepts an explicit
   canonical `projectPath`; picker UI remains available for graphical use.
   Specify truthful not-ready behavior for graph tools.
2. Reuse or extract the existing UI form-to-project operation. Creation takes
   `id`, `version`, `name` and optional `description` with the UI defaults and
   validation; MCP does not require callers to manufacture `model.json`.
3. Wire project requests through the application shell before DiagramCore
   exists, then bind graph requests to the successfully activated editor.
   Preserve selected-tab identity and invalidate stale work during switches.
4. Execute explicit `projectPath` selection through the configured local project
   root. Reject relative/traversal/root paths, invalid model-directory names,
   collisions and malformed projects before mutation. Keep the browser adapter
   authoritative for activation and autosave; never return a filesystem handle.
5. Use the shared project resource loader and ordered writer. Creation rejects
   collisions; failed create/open/switch preserves the prior valid state and
   only rolls back files proven created by that operation.
6. Verify UI/MCP parity for manifest values, active resources, initial graph,
   visible project name, autosave and reopen. Preserve existing package scope
   and avoid copying validation into tool handlers.

## Acceptance criteria

- [ ] New/Open works through public MCP from startup, with supported user permission steps explicit.
- [ ] MCP New/Open accepts an explicit canonical `projectPath` confined to the configured project root.
- [ ] Creation matches every UI form parameter, default and validation rule.
- [ ] Opening activates the same project/resource scope and autosave behavior as the UI.
- [ ] Collision, cancellation, denial and malformed project do not overwrite data or report success.
- [ ] Domain logic is shared with the browser; handles never enter tool results.
- [ ] No changes outside the declared write scope.

## Validation

Run from the repository root; extend the existing suites with the new cases:

```bash
pnpm --dir front-end exec vitest run src/__tests__/projectWorkspace.test.ts src/__tests__/BrowserRPCHandler.test.ts
pnpm --dir front-end check
pnpm --dir front-end guard:package-only
pnpm --dir mcp-server test
git diff --check
```

Follow the repository browser skill. Use a disposable project parent, invoke
MCP New/Open, complete the permitted browser interaction, edit/save and reopen.
Compare with UI New/Open and verify error cases without touching unrelated projects.

## Required handoff

Return changed files, exact checks/results, UI/MCP parity observations, permission
limitations and affected KB statements. Keep paths/handles and credentials out
of protocol evidence. Report blockers instead of substituting server filesystem access.

## Path-mode safety and remaining integration gate

The explicit MCP path mode is lexically confined by the MCP server to
`NNM_PROJECT_ROOT` (the configured project root). It requires an absolute,
canonical path whose final directory is a lowercase model ID; the root itself,
relative paths, traversal, NUL bytes and paths outside the root are rejected.
The browser still owns project activation, resource loading and ordered
autosave. The MCP owner persists only the model file through a narrow save
notification; project handles and credentials never enter RPC results.

The graphical picker remains a separate UI path. MCP path requests are read or
created exclusively under the configured root, transferred as model/resources
to the browser startup bridge, and report success only after the editor's
session-ready callback. Existing projects are never overwritten; create
rollback removes only a directory created by that request. The server-owned
path exception is limited to this explicit user-authorized workflow and does
not expose general remote filesystem access.
