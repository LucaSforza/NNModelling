# Frontend agent guidance

Applies to `front-end/`. Inherit repository-wide rules from `../AGENTS.md`.

## Stack and verification

- Svelte 5, Svelte Flow, Vite 8 and TypeScript.
- Load the repository Svelte skills before editing or reviewing Svelte modules.
- Unit tests use Vitest with the Svelte Vite plugin and generally require no DOM.

Use pnpm commands from the repository root:

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end test:watch
pnpm --dir front-end test:type-system
pnpm --dir front-end test:type-system:models
pnpm --dir front-end guard:package-only
pnpm --dir front-end build
```

Run `check` and the focused Vitest suite for frontend changes. Package type
semantics use the pinned independent oracle through the differential tests.
Package-format compilation, training and backend inference are unavailable.

For final QA, follow `../.agents/skills/verify-task/SKILL.md`. UI, layout,
interaction, browser RPC, import/export, and rendered-diagnostic changes must be
exercised in the live editor through the host-appropriate browser route, in
addition to automated checks. Use a type-valid fixture for the happy path and
distinguish pre-existing fixture diagnostics from regressions.

## State and UI architecture

- `src/core/DiagramCore.ts` owns all diagram business logic as pure TypeScript.
- `src/Diagram.svelte.ts` is a thin Svelte wrapper using `$state.raw` and
  auto-spawns the top-level Input node.
- Every successful public graph mutation emits exactly one synchronous
  `onGraphChanged` notification. Rejected connections and no-ops do not notify.
- Snapshot-based undo/redo has a 50-entry limit. Capture only accepted mutations;
  recursive helpers must not create duplicate snapshots.
- RPC mutations of `$state.raw` arrays must replace the arrays to trigger Svelte
  reactivity.
- `src/sync/BrowserRPCHandler.ts` executes browser RPC requests against the same
  `DiagramCore`; it must not create independent state.

Node components are `CustomNode.svelte`, `JoinNode.svelte`, and
`SubflowNode.svelte`. Standard handle IDs are `in` and `out`; join inputs use
ordered IDs such as `in-0`. Target handles accept one connection, while source
handles may fan out. Reparenting must preserve ancestry-loop protection.

## Package type system

- Every node stores exact package ID, version and display name.
- `src/type-system/` owns package validation, Cordis activation, isolated Lua
  inference, graph scheduling and editor result adaptation.
- Definitions drive kind, parameters, defaults, dtype controls and presentation;
  inference code must not switch on package IDs.
- Tensor types contain nominal string/number dimensions and one canonical dtype.
  Do not recreate legacy constraint solving, `unknown` dtype or implicit casts.
- Missing inputs or required parameters are unresolved editor state. Expected
  semantic errors and host/Lua faults remain distinct.
- Joins retain parents in target-handle order. Subflow composition must preserve
  the innermost diagnostic cause and add semantic context.
- `stereotype-lab` is a pinned independent test oracle, never a production
  dependency.

## Tests and fixtures

- Construct real `Diagram` instances in tests and stub `globalThis.window`
  before construction.
- Package editor fixtures live under `../examples/diagrams/package/`.
- Add regression coverage for graph mutations, connection validation, type
  inference, RPC serialization, and undo/redo at the narrowest applicable level.

Current cross-package contracts are documented in
`../docs/knowledge/architecture/browser-mcp.md`,
`../docs/knowledge/contracts/package-type-system.md`. Historical implementation plans
are preserved under `../docs/archive/completed-plans/`.
