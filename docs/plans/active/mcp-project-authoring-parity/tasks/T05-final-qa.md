---
id: T05
kind: task
status: done
plan: ../plan.md
role: integration
depends_on: [T04]
parallel_with: []
write_scope:
  - docs/plans/active/mcp-project-authoring-parity/evidence/
---

# Run final automated and real-interface QA

## Objective

Prove the four use cases through automated gates and a disposable live project,
then update current KB evidence/status without touching user projects.

## Stop condition

The user explicitly resumed QA. Final automated and live-interface QA passed;
see `../evidence/T05-final-qa.md`.

## Work

1. Load the repository `verify-task` and `nnmodelling-mcp` skills.
2. Run the plan's automated gates.
3. On a disposable project, create/delete each resource through UI and MCP;
   compare manifest, exact directories, live catalogs and reopened state.
4. Exercise cancellation, core/in-use/dependency rejection and injected
   persistence failure/rollback without deleting backend archives or jobs.
5. Record current evidence and update stale KB statements only after proof.

## Acceptance criteria

- [x] All automated gates pass with current results.
- [x] UI/MCP/disk parity is demonstrated for all four use cases.
- [x] Reopen and failure-path evidence proves transactionality.

## Validation

The full frontend suite passed (302 tests), the MCP suite passed (74 tests),
the package-only guard passed, and `svelte-check` reported 0 errors. Disposable
live QA covered both authoring channels, guarded and valid deletions,
cancellation, reopen and injected rollback failure. See the linked evidence.
