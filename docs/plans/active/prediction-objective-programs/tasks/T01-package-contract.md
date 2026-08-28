---
id: T01
kind: task
status: ready
plan: ../plan.md
role: architecture
depends_on: []
parallel_with: []
write_scope:
  - stereotype-packages/
  - front-end/src/type-system/packages/
  - front-end/src/__tests__/packageBundle.test.ts
---

# Define package execution roles

## Objective

Make prediction output and objective target bindings explicit, versioned parts
of package definitions, with no package-ID interpretation.

## Context required

- [Accepted execution decision](../../../../knowledge/decisions/prediction-objective-programs.md)
- `stereotype-packages/core/{cross-entropy,mse-loss,kl-divergence}/`
- package definition parsing and validation under
  `front-end/src/type-system/packages/`

## Invariants

- `kind`, not package ID or display name, owns execution role.
- Every loss explicitly declares `objective.externalInputs`, including an
  explicit empty list for target-free loss contributions.
- V1 accepts only the exact source `batch.targets` and rejects unknown fields or
  sources.
- Each external input name and source occurs at most once per objective node
  and maps to exactly one positional module argument.
- `kind: "output"` is a typed identity operation, not compiler-inserted syntax.

## Work

1. Add failing parser/schema tests for valid bindings, duplicate names,
   duplicate sources, invalid cardinality and output packages.
2. Extend the package definition type and parser with the accepted fields.
3. Add `core.output` with definition, Lua identity inference, PyTorch identity
   builder and focused package tests.
4. Declare target bindings for Cross Entropy and MSE and no external inputs for
   KL divergence.
5. Prove a renamed fixture package with the same definition receives the same
   parsed role.

## Acceptance criteria

- [ ] Missing objective declarations on `kind: "loss"` are rejected.
- [ ] Unknown external sources and duplicate names are rejected.
- [ ] No new package-ID switch is introduced.
- [ ] Standard packages contain matching Lua, PyTorch and definition resources.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/packageBundle.test.ts
pnpm --dir front-end check
```

## Required handoff

Return changed definitions, schema/version implications, exact test results and
any existing package that cannot express its objective inputs under v1.
