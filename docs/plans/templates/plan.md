---
id: replace-with-initiative-id
kind: plan
status: draft
updated: YYYY-MM-DD
areas:
  - replace-with-area
---

# Initiative title

## Goal

State the user-visible or system-level outcome in one paragraph.

## Current behavior

Describe only the current behavior needed to understand the change. Link to
authoritative files or `docs/knowledge/` rather than reproducing them.

## Scope

- Required outcome.
- Required compatibility or migration behavior.

## Non-goals

- Explicitly excluded behavior.
- Follow-up ideas that are not required for completion.

## Decisions and invariants

- Decisions that all tasks must share.
- Existing contracts that must remain true.
- Link durable decisions to `docs/knowledge/decisions/`.

## Contracts and control flow

Describe shared interfaces, data ownership, state transitions, or a small flow
diagram when tasks cannot be implemented independently without this contract.
Omit this section when it adds no useful constraint.

## Task graph

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| `T01` | `architecture` | — | — | `path/` | One observable result |
| `T02` | `frontend` | `T01` | `T03` | `front-end/path/` | One observable result |

Each row must link to a file under `tasks/`. Parallel tasks must have
non-overlapping write scopes.

## Integration and review gates

- Conditions that must hold before task outputs are integrated.
- Cross-package or compatibility checks.
- Review scope and the findings that would block completion.

## Acceptance criteria

- [ ] Criterion observable from behavior, artifacts, or tests.
- [ ] Existing behavior that must remain preserved.

## Final verification

Run from the repository root unless noted otherwise:

```bash
exact command
```

## Knowledge and archive impact

- Current knowledge to create or update when the initiative lands.
- Evidence worth retaining with the completed plan.
- Superseded documents to archive.
