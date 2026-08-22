---
id: T06
kind: task
status: done
plan: ../plan.md
role: frontend
depends_on: [T05]
parallel_with: []
write_scope:
  - front-end/src/type-system/
  - front-end/src/components/
  - front-end/src/nodes/
  - front-end/src/__tests__/packageTypeDtypeLoss.test.ts
  - stereotype-packages/core/cast/
  - stereotype-packages/core/cross-entropy/
  - stereotype-packages/core/embedding/
---

# Complete dtype and loss frontend semantics

## Objective

Add schema-driven dtype selection/display and the remaining dtype/loss core
packages so Cast, Embedding, and Cross Entropy match the reference without
implicit conversion or package-specific UI.

## Context required

- Read the plan, T05 handoff, reference dtype design, frontend ideas, input/loss
  integration rules, standard-library contracts, packages, and tests.
- Inspect current generic parameter rendering and output tooltip behavior.
- Copy `packages/core/cast/`, `cross-entropy/`, and `embedding/`; adapt
  `src/packages/embedding.test.ts`, the matching standard-library tests,
  `src/tensor-type.ts`, and dtype validation from
  `src/packages/validation.ts`. UI rendering is the intended NNModelling-only
  adaptation.

## Invariants

- The canonical dtype vocabulary is closed and carried on every tensor.
- A dedicated declarative dtype selector is not a legacy free-form parameter.
- No operation promotes or casts unless its package Lua explicitly does so.
- `loss` has one graph input and one ordinary scalar tensor output; target data
  is runtime-only and outside this frontend task.
- UI derives controls from schema type/choices/default, never package ID.

## Out of scope

Hardware support warnings, loss target transport, training, PyTorch, dtype
aliases, promotion, and backend construction.

## Acceptance criteria

- [ ] Cast changes only dtype; Embedding enforces selected integer input dtype
  and selected floating output; Cross Entropy returns scalar floating output.
- [ ] Every valid/targeted-invalid result matches the oracle.
- [ ] The editor renders dtype selectors from metadata and displays inferred
  dtype with shape.
- [ ] Missing dtype/shape remains unresolved rather than `unknown`.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/packageTypeDtypeLoss.test.ts src/type-system
pnpm --dir front-end check
pnpm --dir front-end test:integration:smoke
git diff --check
```

Verify Input, Cast, Embedding, and Cross Entropy controls and connection
annotations in the live editor.

## Required handoff

Return UI evidence, canonical dtype coverage, loss cardinality evidence,
candidate/oracle results, commands/results, and the mandatory
reference-to-NNModelling reuse ledger.
