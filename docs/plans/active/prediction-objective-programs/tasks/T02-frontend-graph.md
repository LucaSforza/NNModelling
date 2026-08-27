---
id: T02
kind: task
status: ready
plan: ../plan.md
role: frontend
depends_on: [T01]
parallel_with: [T03]
write_scope:
  - front-end/src/core/
  - front-end/src/type-system/
  - front-end/src/__tests__/
  - examples/diagrams/package/
  - docs/knowledge/contracts/package-type-system.md
---

# Enforce role-aware graph completion

## Objective

Represent one explicit prediction output and one final objective without
treating targets as graph nodes or requiring one undifferentiated terminal.

## Context required

- [Accepted execution decision](../../../../knowledge/decisions/prediction-objective-programs.md)
- T01 package roles and parser handoff
- current DiagramCore completion, persistence and package-bundle tests

## Invariants

- DiagramCore remains the only live graph authority.
- Lua remains the only frontend tensor-inference runtime.
- Join ordering remains `targetHandle`-driven.
- Training targets do not appear as nodes, edges or fabricated tensor types.

## Work

1. Add failing tests for one input, one output role and one objective terminal,
   plus disconnected outputs/losses, incomplete objective joins, outputs inside
   the objective region and multiple objective terminals.
2. Define the objective region as loss nodes plus descendants and reject
   ambiguous/missing output and objective roles for training export.
3. Permit the role-aware pair of terminals while preserving useful partial
   inference for incomplete editor graphs.
4. Update ResNet to branch classifier logits to Output and Cross Entropy.
5. Update the complete VAE to mark decoder reconstruction as Output while
   retaining MSE, KL and their scalar objective join.
6. Verify package bundle export preserves the nodes, roles and ordered edges.
7. Update the current frontend package-type contract after role-aware
   completion is implemented and tested.

## Acceptance criteria

- [ ] The ResNet and VAE fixtures pass frontend type and graph validation.
- [ ] A training graph without Output or objective fails before upload.
- [ ] Multiple or objective-contained Outputs produce actionable diagnostics.
- [ ] No target edge or package-ID rule is introduced.

## Validation

```bash
pnpm --dir front-end test
pnpm --dir front-end check
```

## Required handoff

Return fixture changes, graph diagnostics, exact test results and the exported
bundle shape expected by T03.
