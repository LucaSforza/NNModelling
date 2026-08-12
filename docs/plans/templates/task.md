---
id: T01
kind: task
status: draft
plan: ../plan.md
role: replace-with-role
depends_on: []
parallel_with: []
write_scope:
  - exact/path/or/directory/
---

# Task title

## Objective

Define one observable result. If the sentence needs unrelated conjunctions,
split the work into separate tasks.

## Context required

- Link the plan and relevant current-knowledge documents.
- Name the source symbols or contracts the implementer must inspect.

## Invariants

- Behavior and contracts that must remain true.
- Compatibility or ordering rules that constrain the implementation.

## Allowed files

- Repeat the exact files or directories from `write_scope` and explain any
  boundary that is not obvious.

## Out of scope

- Adjacent changes the implementer must not make.

## Work

1. Inspect the current implementation and relevant tests.
2. Add regression coverage first when behavior is changing and practical.
3. Implement the smallest change that satisfies the objective.
4. Run the targeted checks below.

## Acceptance criteria

- [ ] Concrete behavior or artifact.
- [ ] Required compatibility behavior.
- [ ] No changes outside `write_scope`.

## Validation

Run from the repository root unless noted otherwise:

```bash
exact targeted command
exact integration command, if required
```

## Required handoff

Return:

- files changed and a concise explanation of each change;
- exact commands run and their results;
- decisions or assumptions made within the task contract;
- unresolved risks, blockers, or follow-up work;
- any current-knowledge document that would become inaccurate.

Do not embed provider, model, agent name, commit, branch, or pull-request
instructions here. The active orchestrator adapter adds those execution details.
