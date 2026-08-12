# Internal documentation for agents

`docs/` has two purposes:

1. describe work that an orchestrator can delegate to bounded subagents; and
2. preserve current, internal knowledge that agents need to change the project
   safely.

The canonical documents in this directory are tool-neutral. Codex- and
OpenCode-specific behavior belongs in `docs/orchestrators/`, not in plans or
project knowledge.

## Directory map

```text
docs/
├── plans/
│   ├── active/<initiative>/
│   │   ├── plan.md
│   │   ├── tasks/Txx-<name>.md
│   │   └── evidence/
│   └── templates/
├── knowledge/
│   ├── architecture/
│   ├── contracts/
│   ├── decisions/
│   ├── operations/
│   └── testing/
├── orchestrators/
│   ├── codex.md
│   └── opencode.md
└── archive/
    ├── completed-plans/
    ├── reports/
    └── superseded/
```

- `plans/` contains executable work. An active initiative has one manifest,
  independently assignable tasks, and temporary verification or review
  evidence.
- `knowledge/` describes the system as it exists now. Organize durable material
  by concern rather than by implementation milestone.
- `orchestrators/` translates neutral task roles into a particular agent
  runtime. It may contain provider, model, permission, commit, and delegation
  policy that must not leak into canonical plans.
- `archive/` preserves completed plans, historical reports, and superseded
  descriptions. Archived material is evidence, not current guidance.
- `docs2/` is separate: it builds the public Sphinx documentation for users and
  operators. Internal agent notes do not belong there, and user-facing product
  documentation does not belong in `docs/`.

Do not recreate the retired `docs/design/`, `docs/designs/`, `docs/report/`, or
`docs/reviews/` directories. Classify new material using the directory map
above.

## Authority and duplication

- Code and tests define actual behavior. `knowledge/` explains the current
  contracts and operational model; update it when a change would make it false.
- The initiative `plan.md` owns initiative status and scope. Each task file owns
  its own status. Do not maintain a second status dashboard in evidence files.
- Record a durable architectural choice once in `knowledge/decisions/` and link
  to it from tasks. Avoid copying the decision into several plans.
- Do not record volatile test counts, branch names, commit hashes, approvals, or
  narrative implementation history in current knowledge. Git and archived
  evidence preserve that history.

## Plan lifecycle

Use these states:

```text
draft -> ready -> in_progress -> done
                    |-> blocked
draft | ready | done -> superseded
```

- `draft`: decisions or task boundaries are still being developed.
- `ready`: scope, dependencies, acceptance criteria, and validation are usable
  without rediscovery.
- `in_progress`: an orchestrator has begun assigning or integrating tasks.
- `blocked`: progress needs user input or an external state change; name the
  blocker in the owning document.
- `done`: acceptance and integration gates passed.
- `superseded`: another document or decision replaced this one; add a
  `superseded_by` link.

To close an initiative:

1. run its final validation and save only useful evidence;
2. promote durable facts and decisions into `knowledge/`;
3. mark the plan `done`; and
4. move the initiative intact to `archive/completed-plans/`.

## Tool-neutral planning rules

Start from [`plans/templates/plan.md`](plans/templates/plan.md) and
[`plans/templates/task.md`](plans/templates/task.md). Plans describe capability,
ownership, dependencies, and observable outcomes. They must not name a model,
provider, callable agent, chat command, commit, branch, or pull request.

Use stable task roles such as:

- `architecture`
- `frontend`
- `backend`
- `integration`
- `review`
- `documentation`
- `operations`

An adapter maps these roles to available agents. A task should have one
observable result, an explicit `write_scope`, exact validation commands, and a
handoff contract. Tasks may run in parallel only when their dependencies are
satisfied and their write scopes do not overlap.

## Writing current knowledge

A knowledge document should answer what an agent needs to know now: ownership,
contracts, invariants, failure modes, and verification. Prefer links to source
files and tests over copied code. If a document is no longer true, update it or
move it to `archive/superseded/`; do not leave an unbounded warning at the top of
an otherwise stale document.
