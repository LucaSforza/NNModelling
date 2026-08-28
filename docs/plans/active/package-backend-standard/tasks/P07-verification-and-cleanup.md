---
id: P07
kind: task
status: ready
plan: ../plan.md
role: integration
depends_on: [P04, P05, P06]
write_scope:
  - converted/src/tests/
  - front-end/src/__tests__/
  - docs/plans/active/package-backend-standard/evidence/
---

# Verify the standard path and delete unreachable legacy code

Run security, storage, compiler, trainer, controller, frontend and API tests.
Through the real browser/API path submit one valid CPU package graph, observe
SSE terminal state and logs, and install the downloaded wheel outside the
checkout. Exercise invalid source, unknown/unauthorized references, limits,
cancellation, ordered joins and nested subflows.

Only after these checks pass, delete unreachable NNTree conversion modules,
executors, fixtures, endpoints and tests from the backend standard. Record the
dependency proof and the Podman/Docker smoke results as evidence.

Validation:

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end guard:package-only
cd converted && uv run pytest src/tests/ -m fast -q
git diff --check
```
