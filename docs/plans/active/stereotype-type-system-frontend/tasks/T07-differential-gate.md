---
id: T07
kind: task
status: draft
plan: ../plan.md
role: testing
depends_on: [T06]
parallel_with: []
write_scope:
  - front-end/tests/differential/
  - front-end/package.json
  - pnpm-lock.yaml
  - .gitignore
  - docs/knowledge/contracts/
  - docs/plans/active/stereotype-type-system-frontend/evidence/
---

# Port the reference frontend suite and black-box protocol

## Objective

Run the pinned `stereotype-lab` Bun suite unchanged in its own checkout, copy or
adapt every frontend-semantic case into NNModelling, and expose both
implementations through the same versioned black-box protocol.

## Context required

- Read the complete plan and all prior handoffs/reuse ledgers.
- In the reference, read `design/testing/`, structured diagnostics, all core
  packages, and the current public TypeScript exports used by the oracle
  adapter.
- Inventory and account for `src/packages/core.test.ts`,
  `src/packages/standard-library.test.ts`, `src/packages/embedding.test.ts`,
  `src/models/subflow-models.test.ts`,
  `src/lua/lua-inference-runtime.test.ts`, and their fixtures.
- Copy test inputs, fixtures and observable assertions whenever possible. A
  browser adaptation may translate filesystem package loading, but it must not
  weaken the expected semantic result.

## Invariants

- Oracle and candidate are independent processes and reject protocol-version
  mismatches.
- Running candidate copies of tests alone is not cross-validation: the original
  pinned reference suite and TypeScript check must also pass.
- Every reference test has a reuse-ledger row: `copied`, `adapted`, or
  `reference-only` with a concrete reason.
- The oracle revision is pinned exactly in test configuration; a local override
  is explicit and CI clones into an ignored cache.
- Requests contain semantic data only: no Svelte, NNTree, Cordis fiber, editor
  coordinate, or Python object.
- Shared-package and product-package modes are both mandatory.

## Out of scope

Graph generation, randomized fuzzing, production oracle access,
backend/PyTorch validation, package manager behavior, and rewriting reference
expectations to fit candidate behavior.

## Acceptance criteria

- [ ] The original pinned Bun suite and TypeScript check pass in the independent
  reference checkout.
- [ ] Every applicable frontend-semantic case passes against the candidate with
  the same inputs and observable assertions.
- [ ] The reuse ledger accounts for every inventoried test and substantial
  copied/adapted source file.
- [ ] The versioned JSON protocol distinguishes success, expected error, and
  runtime fault and rejects mismatched protocol versions.
- [ ] Shared-package and product-package deterministic scenarios both pass.

## Validation

```bash
pnpm --dir front-end test:stereotype-conformance
pnpm --dir front-end check
git diff --check
```

## Required handoff

Return the full test inventory/reuse ledger, original oracle results, candidate
results, protocol schema/version, pinned-oracle resolution procedure, and every
deliberate adaptation or exclusion.
