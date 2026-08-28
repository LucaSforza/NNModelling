---
id: T03
kind: task
status: done
plan: ../plan.md
role: frontend
depends_on: [T02]
parallel_with: []
write_scope:
  - front-end/src/type-system/
  - front-end/src/conversion/typeDiagnostics.ts
  - front-end/src/nodes/
  - front-end/src/components/Sidebar.svelte
  - front-end/src/__tests__/packageTypeDiagnostics.test.ts
  - stereotype-packages/core/linear/
---

# Preserve and render structured diagnostics

## Objective

Make a `core.linear` dtype/feature mismatch an expected structured diagnostic,
make a broken Lua fixture a separate runtime fault, and render both through the
editor adapter without flattening the semantic cause.

## Context required

- Read the plan, migration decision, T02 handoff, current diagnostic helpers,
  node indicators, and sidebar rendering.
- In the reference, read the structured-diagnostics design, dtype design,
  `packages/core/linear/`, Lua runtime faults, and relevant tests.
- Copy/adapt `packages/core/linear/`, its standard-library cases,
  `src/lua/lua-inference-runtime.ts`, and the fault tests. Do not copy the
  `PackageLoader.infer` catch that flattens thrown faults into expected string
  errors; it conflicts with normative design.

## Invariants

- Diagnostic storage is one leaf cause plus frames ordered inner-to-outer.
- Editor node ID/location is adapter metadata, not semantic oracle data.
- Runtime faults retain package ID, phase, source/line when available, and the
  underlying cause. They are never converted into expected inference errors.
- Stable codes, warnings, multiple causes and source spans are not introduced.

## Out of scope

Iteration/branch frames, joins, subflows, backend, warning design, and legacy
diagnostic compatibility.

## Acceptance criteria

- [ ] Linear success and dtype/feature failures match oracle semantics.
- [ ] The innermost mismatch remains machine-readable after node/package
  context is added.
- [ ] A Lua exception/budget fault follows the fault presentation path.
- [ ] UI rendering is derived from structured data and contains no package-ID
  switch.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/packageTypeDiagnostics.test.ts src/type-system
pnpm --dir front-end check
pnpm --dir front-end test:integration:smoke
git diff --check
```

Exercise success, expected mismatch, and curated fault in the live editor and
inspect both the node indicator and sidebar details.

## Required handoff

Return the exact diagnostic/fault schemas, rendering evidence, oracle
comparisons, commands/results, deferred diagnostic requirements, and the
mandatory reference-to-NNModelling reuse ledger.
