---
id: T04
kind: task
status: draft
plan: ../plan.md
role: architecture
depends_on:
  - T03
parallel_with: []
write_scope:
  - front-end/src/core/scopeGraph.ts
  - front-end/src/type-system/subflowEvaluator.ts
  - front-end/src/conversion/nnTree.ts
  - front-end/src/__tests__/scopeGraph.test.ts
  - front-end/src/__tests__/subflowTypeExpressions.test.ts
  - front-end/src/__tests__/nnTree.test.ts
---

# Add generic subflow apply and iterate semantics

## Objective

Provide a runtime-consistent subflow application capability so Shape/DType
expressions can apply or iterate an internal graph without a Repeat or
HorizontalRepeat branch.

## Context required

- [Initiative plan](../plan.md), sections A.7, D.3-D.4 and G.
- T03 evaluator handoff.
- `front-end/src/conversion/typeEngine.ts:946-1270`.
- `front-end/src/conversion/nnTree.ts:141-221`.
- `converted/src/ops/subflow.py` and `repeat.py` as runtime evidence.

## Invariants

- DiagramCore remains the sole live graph owner.
- Entry/exit/cycle and target-handle ordering are structural, generic rules.
- A single-output signature requires exactly one structural exit.
- Each `apply` gets a fresh local scope and inherited global scope.
- Each `iterate` step performs normal signature validation and reports its
  iteration number.

## Allowed files

- Only the six paths in `write_scope`.
- Changes to `nnTree.ts` must be limited to consuming the shared structural
  descriptor without altering serialized NNTree shape.

## Out of scope

- Migrating Subflow JSON or replacing the production TypeEngine.

## Work

1. Extract a pure scope descriptor for children, internal edges, ordered
   predecessors, topological order, unique entry and unique exit.
2. Align NNTree subflow compilation with that descriptor and preserve hidden
   children and target-handle ordering.
3. Implement `applySubflow` by evaluating nodes through T03 using the descriptor.
4. Implement iteration traces, fresh locals and safe annotation aggregation for
   visual IDs reused across iterations.
5. Test normal shape-changing apply, declarative HorizontalRepeat, a compatible
   shape-changing Repeat, an incompatible later iteration, nested subflows and
   ambiguous entry/exit failures.

## Acceptance criteria

- [ ] Type and NNTree traversal use one structural contract.
- [ ] No Subflow action or stereotype name selects behavior.
- [ ] Repeat incompatibility is attributed to the internal node and exact step.
- [ ] NNTree public JSON remains compatible for valid existing fixtures.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/scopeGraph.test.ts src/__tests__/subflowTypeExpressions.test.ts src/__tests__/nnTree.test.ts
pnpm --dir front-end check
```

## Required handoff

Return shared topology contract, compatibility evidence, files changed,
commands/results and any imported diagram newly rejected as ambiguous.
