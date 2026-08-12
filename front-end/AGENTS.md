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
pnpm --dir front-end test:integration:smoke
pnpm --dir front-end test:integration:convert
pnpm --dir front-end test:integration:forward
pnpm --dir front-end test:integration:train
pnpm --dir front-end test:integration:infer
```

Run `check` and the focused Vitest suite for frontend changes. Integration tiers
spawn Python through `uv`; training and inference tiers are slow and should be
run only when relevant. Useful variables include `NNM_DIAGRAM`, `NNM_DEVICE`,
`NNM_TIER`, `NNM_WANDB_MODE`, and `NNM_KEEP_TEMP`.

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

## Compilation and type engine

- `src/conversion/nnTree.ts` compiles the graph with topological ordering and
  recursively preserves subflows as `type: "subflow"` nodes.
- Joins retain parents in target-handle order. Hidden subflow children compile.
- `src/conversion/typeEngine.ts` interprets stereotype JSON declarations. Keep
  formulas in expression strings and join/subflow behavior in declarative config.
- Dimension kinds include constants, symbolic bindings, parameter references,
  wildcards, computed expressions, and parameter spreads.
- Invalid parameter values are errors; unset compatible values may produce
  suggestions. Dtype and advisory diagnostics are warnings where declared.
- Primary errors own diagnostics; downstream nodes should use `blockedBy` rather
  than duplicate the same failure.
- Subflow inference is recursive. Repeat composes its internal transform and
  HorizontalRepeat applies its declared final-dimension transform.
- Einsum inference uses the declarative equation and rejects unsupported ellipsis.

The expression language lives in `src/expr/` and supports symbolic variables,
wildcard products, arithmetic, grouping, and the documented built-ins. Extend it
through parser/evaluator tests, not through module-specific branches.

## Tests and fixtures

- Construct real `Diagram` instances in tests and stub `globalThis.window`
  before construction.
- Prefer helpers from `src/__tests__/helpers.ts` for nodes and edges.
- Integration fixtures come from `../examples/manifest.json`, editable diagrams
  from `../examples/diagrams/`, and compiled fixtures from
  `../examples/nntrees/`.
- Add regression coverage for graph mutations, connection validation, type
  inference, RPC serialization, and undo/redo at the narrowest applicable level.

Current cross-package contracts are documented in
`../docs/knowledge/architecture/browser-mcp.md`,
`../docs/knowledge/contracts/nntree.md`, and
`../docs/knowledge/contracts/tensor-types.md`. Historical implementation plans
are preserved under `../docs/archive/completed-plans/`.
