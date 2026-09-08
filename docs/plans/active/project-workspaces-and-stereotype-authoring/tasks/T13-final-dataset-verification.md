---
id: T13
kind: task
status: blocked
plan: ../plan.md
role: verification
depends_on: [T12]
parallel_with: []
write_scope:
  - front-end/tests/
  - converted/src/tests/
  - mcp-server/
  - docs/knowledge/
  - docs/plans/active/project-workspaces-and-stereotype-authoring/
  - docs/archive/completed-plans/project-workspaces-and-stereotype-authoring/
---

# Verify datasets and close the two-phase initiative

## Objective

Exercise the complete supported project/dataset/training workflows through the
real interfaces, prove the security boundary and only then align current
knowledge and archive the initiative.

## Invariants

- Use the visible browser-owned editor and real backend worker boundary.
- Test project resources live in an explicit temporary parent and remain within
  the advertised small/medium dataset limit.
- Closure requires phase-one evidence as well as phase-two evidence.

## Work

1. Re-run critical New/Open/autosave/stereotype phase-one journeys.
2. Create and reopen a project dataset with named inputs/targets and data files.
3. Train once with a migrated built-in and once with the project dataset.
4. Exercise multiple input bindings and an autoregressive pair.
5. Verify limit/path/ownership failures and worker-only Python execution.
6. Verify visible editor, backend and MCP dataset/job parity.
7. Run final gates, update only affected current KB pages, mark tasks complete
   and archive the plan with concise retained evidence.

## Acceptance criteria

- [ ] Every plan criterion is proven through its supported interface.
- [ ] Both built-in and project datasets produce named batches successfully.
- [ ] Security/failure evidence proves there is no host execution fallback.
- [ ] Large/resumable dataset support remains explicitly deferred.
- [ ] Current knowledge matches the implemented contracts before archival.

## Required handoff

Report real user journeys, dataset/job identities, container-boundary evidence,
exact commands/results, remaining limits and archive location.
