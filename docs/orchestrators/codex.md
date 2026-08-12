# Codex adapter

This file maps NNModelling's tool-neutral plans to Codex execution. Canonical
scope, dependencies, acceptance criteria, and validation live under
`docs/plans/`; this adapter must not redefine them.

## Load project context

Codex reads the repository `AGENTS.md` and the closest package-local
`AGENTS.md`. Before delegating, the coordinating task reads the active
initiative, the selected task files, and linked `docs/knowledge/` documents.
Applicable repository skills remain authoritative for specialized workflows.

## Role mapping

Map a task's neutral `role` to a bounded Codex subagent assignment:

| Plan role | Codex assignment |
| --- | --- |
| `architecture` | Contract or design analysis owned by the coordinating task unless explicitly delegated |
| `frontend` | Front-end implementation subagent with the relevant Svelte/TypeScript skills |
| `backend` | Python/runtime/backend implementation subagent with the relevant Python skills |
| `integration` | Integration and verification subagent whose write scope is explicitly bounded |
| `review` | Read-only or narrowly scoped review subagent |
| `documentation` | Documentation subagent limited to named internal or public paths |
| `operations` | Runtime-diagnostics subagent following the applicable browser/backend skill |

Agent models and reasoning levels are execution choices. Never add them to a
canonical plan or task.

## Repository subagent profile

For delegated NNModelling work, explicitly request `gpt-5.6-luna` with maximum
reasoning effort when that model is exposed by the current Codex subagent API.
If Luna is unavailable, use `gpt-5.6-terra` with maximum reasoning effort. Do
not rely on implicit inheritance from a coordinating Sol task: pass the model
and reasoning choice in the delegation request and treat an unsupported choice
as a reason to apply the documented fallback.

This is a Codex runtime preference, not project-plan metadata. It must never be
copied into `docs/plans/`.

## Delegation

Codex uses subagents when the user explicitly requests delegation or applicable
repository guidance requires it. The coordinating task:

1. verifies that all `depends_on` tasks are complete;
2. copies the objective, invariants, write scope, acceptance criteria,
   validation, and handoff fields into the assignment;
3. gives each writing subagent non-overlapping ownership;
4. runs independent tasks in parallel only when the task graph permits it;
5. collects concise handoffs instead of raw logs; and
6. integrates and verifies the combined result before closing the initiative.

Subagents share the worktree, so parallel writes to the same file or directory
are unsafe even when the product supports concurrent agents. Route review
findings back to the subagent that owns the affected task when it is still
available.

## Git and external actions

Commit, push, pull-request, issue, credential, and other external-write policy
belongs to the Codex task and current user authorization, not to plan files.
Before an authorized commit, inspect the integrated diff and stage only the
intended files. A task is not considered correct merely because it produced a
commit.

## Completion

The coordinating task closes an initiative only after task acceptance criteria,
integration gates, and final validation pass. It then updates durable
`docs/knowledge/` material and follows the archive lifecycle in `docs/README.md`.
