---
id: T08
kind: task
status: blocked
plan: ../plan.md
role: frontend-compiler
depends_on: [T07]
parallel_with: [T09, T10]
write_scope:
  - stereotype-packages/core/input/
  - front-end/src/lib/
  - front-end/src/diagram-core/
  - front-end/src/training/
  - front-end/src/__tests__/
---

# Bind graph inputs and objectives to named batch slots

## Objective

Generalize the graph/training boundary from one anonymous input and target to
explicit named tensor slots while preserving `DiagramCore` authority.

## Invariants

- One or more top-level Input nodes have distinct stable binding names.
- Internal subflow Input/Fork semantics do not change.
- Objective external values bind exact sources such as
  `batch.targets.next_tokens`.
- Dataset/graph compatibility fails before training, not during an epoch.

## Work

1. Add canonical Input binding metadata and editor validation.
2. Compile named model input and objective-target bindings deterministically.
3. Validate required/extra slots, shape variables and dtypes against a selected
   dataset descriptor.
4. Preserve loading diagnostics for older single-Input diagrams.
5. Add singleton, multiple-input, autoregressive and failure tests.

## Acceptance criteria

- [ ] Multiple top-level Inputs compile in a deterministic named order.
- [ ] Missing, duplicate and incompatible bindings produce actionable errors.
- [ ] Existing singleton input/target diagrams retain equivalent behavior.
- [ ] No binding depends on traversal or dictionary iteration order.

## Required handoff

Report graph format changes, compatibility behavior, compiled binding examples
and preflight validation evidence.
