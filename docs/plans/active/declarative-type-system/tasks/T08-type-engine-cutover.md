---
id: T08
kind: task
status: draft
plan: ../plan.md
role: integration
depends_on:
  - T04
  - T05
  - T06
  - T07
parallel_with: []
write_scope:
  - front-end/src/core/StereotypeCore.ts
  - front-end/src/conversion/typeEngine.ts
  - front-end/src/conversion/tensortypes.ts
  - front-end/src/conversion/typeDiagnostics.ts
  - front-end/src/Diagram.svelte.ts
  - front-end/src/__tests__/typeEngine.test.ts
---

# Cut production inference over to v2

## Objective

Make the live editor load compiled v2 signatures and use the generic evaluator
as the only production inference path while keeping public type-result behavior
compatible.

## Context required

- [Initiative plan](../plan.md), especially sections E.3 and F.
- Handoffs and validation results from T04-T07.
- Current public contracts in `docs/knowledge/contracts/tensor-types.md`.

## Invariants

- `TypeEngine.infer()` remains the public graph entry point.
- Errors, warnings, suggestions, `blockedBy` and serialized annotations remain
  available to UI/RPC clients.
- DiagramCore remains the sole live graph authority.
- No release flag or permanent v1 evaluator is introduced.
- Display names may be used in messages but never in semantic decisions.

## Allowed files

- Only the six paths in `write_scope`.

## Out of scope

- Join +/- UI behavior, documentation and Python runtime changes.

## Work

1. Replace raw `any` signature loading with the T01 decoder/compiler and
   aggregated, path-specific failures.
2. Adapt/re-export public tensor/result types without leaking the parser's
   internal typed AST to UI/RPC contracts.
3. Rewrite `TypeEngine` as topological orchestration around T03/T04, collecting
   every node's ordered inputs without `sig.kind`/category branches.
4. Normalize legacy anonymous subflow nodes to the approved generic signature
   at the boundary without a name-dependent rule.
5. Delete Join/Subflow configs, action switches, Concat resolver, advisory
   strategies, tuple parsing duplication and implicit dtype fallbacks.
6. Replace stale monolithic tests with externally observable v2 graph cases,
   preserving primary-error/blocked-node behavior.

## Acceptance criteria

- [ ] Production inference has one semantic evaluator.
- [ ] `typeEngine.ts` contains no ordinary stereotype/action/parameter-specific
      branch.
- [ ] Loader failures identify file and JSON/expression path.
- [ ] Existing UI/RPC consumers compile without a result-shape migration.
- [ ] Legacy saved diagrams still load and obtain types.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/typeEngine.test.ts src/__tests__/typeDiagnostics.test.ts src/__tests__/BrowserRPCHandler.test.ts
pnpm --dir front-end check
pnpm --dir front-end test
```

## Required handoff

Return deleted semantic paths, compatibility adapter boundaries, files changed,
exact commands/results and any current knowledge that became false.
