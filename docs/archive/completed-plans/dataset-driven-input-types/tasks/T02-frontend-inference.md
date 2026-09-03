---
id: T02
kind: task
status: done
plan: ../plan.md
role: frontend
depends_on: [T01]
parallel_with: []
write_scope:
  - front-end/src/
  - front-end/src/__tests__/
---

# Resolve live Input types from the selected dataset

## Objective

Make editor type inference and diagnostics react deterministically to the
selected dataset, named bindings and resolved dimension parameters.

## Context required

- [Initiative](../plan.md)
- T01 handoff and resolved dataset-input contract
- `front-end/src/type-system/`
- `front-end/src/training/controller.ts`
- Input node and parameter UI components

## Invariants

- DiagramCore remains the only graph authority.
- No dataset means unresolved Input-dependent inference, not a fabricated type.
- Dataset selection or parameter changes invalidate every dependent result.
- Internal subflows never resolve top-level dataset slots directly.

## Allowed files

Frontend source and focused frontend tests only.

## Out of scope

- Python compiler, worker, wheel runtime and VAE example migration.

## Work

1. Trace dataset selection, parameter editing, inference scheduling, graph
   validation, persistence and browser RPC presentation end to end.
2. Add tests for absent dataset, binding success/failure, symbols, multiple
   Inputs, dataset switching and stale-cache invalidation.
3. Resolve each top-level Input from the selected named slot before ordinary
   package-driven Lua propagation.
4. Remove shape/dtype controls from top-level Input UI and expose the binding
   plus dataset-derived read-only type and actionable diagnostics.
5. Verify serialization, reload and browser RPC report the same state.

## Acceptance criteria

- [ ] Dataset selection and parameter changes immediately recompute types.
- [ ] Missing or invalid context produces precise unresolved/error states.
- [ ] Multiple named Inputs resolve independently.
- [ ] Top-level Input UI contains no editable shape/dtype source.
- [ ] Persistence and browser RPC agree with the visible editor.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test
pnpm --dir front-end check
git diff --check
```

## Required handoff

Return files changed, state transitions, diagnostics, cache invalidation proof,
commands/results and any backend assumption T03/T05 must verify.
