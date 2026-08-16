---
id: T11
kind: task
status: draft
plan: ../plan.md
role: documentation
depends_on:
  - T09
  - T10
parallel_with: []
write_scope:
  - AGENTS.md
  - front-end/AGENTS.md
  - Stereotypes/AGENTS.md
  - docs/knowledge/contracts/tensor-types.md
  - docs2/source/type_system.rst
  - docs/plans/active/declarative-type-system/evidence/
---

# Update contracts and perform final user-facing verification

## Objective

Make current/internal/public documentation describe the landed v2 system and
prove the requested behaviors through automated gates and the live editor.

## Context required

- [Initiative plan](../plan.md), acceptance and integration gates.
- All prior task handoffs.
- Current agent guidance and tensor-type contract in `write_scope`.

## Invariants

- Documentation describes current behavior only; historical actions remain in
  archived evidence, not current guidance.
- Do not copy volatile test counts into current knowledge.
- Preserve useful evidence only; task/plan files own status.
- Real-user verification uses editable source diagrams, not compiled NNTree
  fixtures as if they were editor inputs.

## Allowed files

- Only the six paths/directories in `write_scope`.

## Out of scope

- Runtime fixes discovered during verification. Report them as blockers or
  follow-up work rather than expanding this task.

## Work

1. Replace action-based Join/Subflow descriptions with v2 groups, shape
   definitions, constraints, dtype expressions and explicit scope.
2. Document the human-readable expression syntax, its load-time typed
   compilation, the intentional `EinsumShape` exception and extension rule.
3. Update repository/package guidance so future changes do not reintroduce
   actions or name branches.
4. Run focused, package, integration and documentation gates from the plan.
5. In the live editor verify a normal pattern layer, three-input Addition and
   Concat, MatMul ordering, normal subflow, HorizontalRepeat, compatible and
   failing Repeat, and Einsum. Inspect node diagnostics and conversion blocking.
6. Save concise evidence only for manual cases and unresolved failures.

## Acceptance criteria

- [ ] Current knowledge and public docs agree with implementation and schema.
- [ ] All final commands pass or a blocking failure is documented with current
      evidence.
- [ ] Every user-requested architectural test case is exercised.
- [ ] The initiative can be promoted to `done` without unresolved required work.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- src/__tests__/typeSchema.test.ts src/__tests__/typeExpressions.test.ts src/__tests__/signatureEvaluator.test.ts src/__tests__/subflowTypeExpressions.test.ts src/__tests__/typeArchitecture.test.ts
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end test:integration:smoke
pnpm --dir front-end test:integration:convert
pnpm --dir front-end test:integration:forward
pnpm run docs
```

## Required handoff

Return documentation changed, exact commands/results, live-editor scenarios and
outcomes, retained evidence links and any blocker preventing plan completion.
