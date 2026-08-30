---
id: T02
kind: task
status: draft
plan: ../plan.md
role: integration
depends_on: [T08]
parallel_with: []
write_scope:
  - front-end/src/components/Sidebar.svelte
  - front-end/src/Diagram.svelte.ts
  - front-end/src/type-system/editor/
  - front-end/src/sync/BrowserRPCHandler.ts
  - front-end/src/__tests__/
  - mcp-server/src/server.ts
  - mcp-server/src/tools/graph.ts
  - mcp-server/src/tools/parameters.ts
  - mcp-server/src/tools/validation.ts
  - mcp-server/src/errors.ts
  - mcp-server/__tests__/
---

# Share sidebar-equivalent node operations

## Objective

Satisfy M1–M3 through the public MCP contract while preserving editor semantics.

## Context required

Read the [initiative plan](../plan.md), its source links and the
[accepted UML](../../../../knowledge/uml/mcp-use-case-parity.md).

Inspect Sidebar `onPackageChange`, `handleCreate`, `handleManualUpdate`, reference conversion, `initialPackageParameters`, `addActivatedPackageNode` and the RPC equivalents.

## Invariants

Package definitions drive types/defaults/options. Preserve exact package identity, adapters, join handle ordering, one logical mutation notification, undo/redo and autosave. Missing required values remain the editor's unresolved state rather than a new transport-specific rule.

## Allowed files

- `front-end/src/components/Sidebar.svelte`
- `front-end/src/Diagram.svelte.ts`
- `front-end/src/type-system/editor/`
- `front-end/src/sync/BrowserRPCHandler.ts`
- `front-end/src/__tests__/`
- `mcp-server/src/server.ts`
- `mcp-server/src/tools/graph.ts`
- `mcp-server/src/tools/parameters.ts`
- `mcp-server/src/tools/validation.ts`
- `mcp-server/src/errors.ts`
- `mcp-server/__tests__/`

Directory scopes permit only changes serving this task. Narrow them to the
actual files in the handoff; do not reorganize unrelated modules.

## Out of scope

No stereotype authoring, package runtime/type-language redesign, layout work or training controller.

## Work

1. Add parity tests before changing behavior: omitted defaults, explicit false/zero, shape/list values, nested package references, adapters, output kind, package activation failure and invalid handles.
2. Extract only the shared preparation needed by Sidebar and RPC; route both through activated package creation. Honor overrides, default join arity and presentation options without package-ID switches.
3. Accept canonical typed JSON parameter values in MCP; validate using the selected package definition, not universal string coercion. Keep UI raw-input parsing at its presentation boundary.
4. Fix the advertised package-only contract and output kind, including wheelAdapters. Legacy stereotype-only input must fail with an actionable message rather than appear supported.
5. Retain runtime parsers in the MCP registry and validate before handler dispatch, after repairing schemas. Add useful descriptions/prerequisites. Test tools/list and tools/call with valid and invalid inputs, not only direct handlers.
6. Preserve connect_nodes delegation. Replace constant-success validators with existing authoritative diagnostics, or explicitly report unsupported checks with no valid:true claim. Do not build a new validation engine or change pending named-input semantics.

## Acceptance criteria

- [ ] MCP-created and sidebar-created nodes agree on domain values, defaults and options.
- [ ] All declared parameter kinds round-trip without stringification or partial invalid mutation.
- [ ] Invalid public payloads produce useful errors before mutation; existing valid calls retain behavior.
- [ ] Connection rejection, join ordering, undo/redo, autosave and package scope are verified.
- [ ] No changes outside the declared write scope.

## Validation

Run from the repository root. Extend the listed tests for the new behavior;
passing unchanged proxy mocks alone is not proof of this task.

```bash
pnpm --dir front-end exec vitest run src/__tests__/BrowserRPCPackageOnly.test.ts src/__tests__/BrowserRPCHandler.test.ts
pnpm --dir front-end check
pnpm --dir front-end guard:package-only
pnpm --dir mcp-server test
```

Extend the existing suites and add a public-dispatch test if needed. In a disposable real editor project, create/edit equivalent nodes from sidebar and MCP, compare exported domain data, then undo/redo and reopen the saved project.

## Required handoff

Return changed files, exact checks/results, observed user-facing behavior,
resolved assumptions, remaining blockers and affected KB statements. Keep
credentials out of evidence. Update this task's status in its own file; the
initiative plan owns overall status.
