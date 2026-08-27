---
id: T07
kind: task
status: superseded
plan: ../plan.md
superseded_by: ../../package-backend-standard/tasks/P07-verification-and-cleanup.md
role: integration
depends_on: [T05, T06]
parallel_with: []
write_scope:
  - converted/src/tests/
  - front-end/src/__tests__/
  - docs/plans/active/package-pytorch-backend/evidence/
---

# Verify the package-to-container path

## Objective

Prove the requested outcome through the public browser/API and worker
interfaces while checking the cross-package invariants and legacy behavior.

## Context required

- [Initiative plan](../plan.md)
- Completed T02–T06 handoffs.
- `docs/knowledge/testing/strategy.md`
- `converted/src/tests/test_backend_e2e.py`
- `front-end/src/__tests__/packageTypeGraph.test.ts`
- The repository's browser/container verification skills.

## Invariants

- Use a valid fixture with a join and nested subflow; do not use a malformed
  fixture as happy-path evidence.
- Verify frontend type result and backend runtime result separately.
- Verify bundle ownership, digest, archive validation, limits, cancellation,
  logs, SSE terminal status and artifact download.
- Preserve and rerun the legacy NNTree path.

## Allowed files

- Focused existing/new tests and evidence files only.

## Out of scope

- Fixing unrelated pre-existing failures.
- Adding new product behavior discovered during QA.

## Work

1. Run focused unit tests for exporter, runtime, API and executor.
2. Run frontend package gates and backend fast tests.
3. Start the configured backend/container stack and submit one CPU package job
   through the real API/UI; inspect rendered status, logs and artifact digest.
4. Run malformed bundle, unauthorized owner, join-order and cancellation
   checks; record only useful evidence.
5. Classify failures as change-caused, environment-caused or pre-existing.

## Acceptance criteria

- [ ] One real package job reaches a terminal success in the isolated worker.
- [ ] One expected failure proves invalid package code/resources are rejected
      before execution or reported with package context.
- [ ] Legacy NNTree and package inference gates both pass.
- [ ] Evidence includes exact commands and current results, not historical
      counts.

## Validation

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end guard:package-only
cd converted && uv run pytest src/tests/ -m fast -q
git diff --check
```

## Required handoff

Return exact evidence paths, commands/results, real-interface observations,
environment blockers and any acceptance criterion that remains unproven.
