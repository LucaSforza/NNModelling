---
id: T02
kind: task
status: complete
plan: ../plan.md
role: dependency-migration
depends_on:
  - T01
parallel_with: []
write_scope:
  - front-end/package.json
  - package.json
  - pnpm-lock.yaml
  - front-end/pnpm-lock.yaml
  - front-end/src/type-system/host.ts
  - front-end/src/type-system/packages/loader.ts
  - front-end/src/__tests__/cordisMigration.test.ts
  - front-end/tests/differential/oracle-adapter.ts
---

# Migrate to upstream Cordis without refactoring

## Objective

Replace the DeepSeek fork with exact upstream `cordis@4.0.0-rc.8` and prove the
characterized lifecycle under the new dependency while leaving production
structure unchanged.

## Context required

- [Initiative migration strategy](../plan.md#forward-and-rollback-strategy)
- [T01 handoff](T01-characterize-cordis-contracts.md)
- [Upstream core manifest](https://github.com/cordiverse/cordis/blob/main/packages/core/package.json)
- every current `@deepseek-ai/cordis` import and lockfile entry

## Invariants

- Use the exact string `"cordis": "4.0.0-rc.8"`; no caret, alias, Git URL, or
  fork package remains.
- Do not change activation, lease, registry, inference, or disposal code beyond
  the import source required to compile.
- Do not mix formatting or unrelated dependency updates into the lockfile diff.
- Treat T01 failure as a migration failure. Do not patch around it with a
  compatibility flag.

## Work

1. Confirm T01 passes on the pre-migration tree and retain its output.
2. Replace the frontend dependency and all production/test imports.
3. Regenerate the workspace lockfile with pnpm using the smallest command that
   updates this dependency.
4. Remove stale fork-specific package and peer-package lock entries.
5. Run the T01 suite first, then frontend type checking and the differential
   oracle tests that construct a Cordis context.
6. Inspect the diff and prove it contains only dependency/import migration.

## Rollback

If the gate fails, restore `@deepseek-ai/cordis@^4.0.1`, its imports, and the
pre-migration lockfile. There is no persisted-data or compatibility migration
to reverse at this stage. Report the smallest upstream behavioral difference
with a failing test; do not start T03.

## Acceptance criteria

- [x] `@deepseek-ai/cordis` has zero repository matches outside archived
      evidence that intentionally names the old dependency.
- [x] `cordis@4.0.0-rc.8` is the only Cordis runtime in the relevant pnpm graph.
- [x] T01 passes unchanged under upstream Cordis.
- [x] Frontend checking and selected differential tests pass.
- [x] No lifecycle refactor appears in the diff.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/cordisMigration.test.ts src/__tests__/packageLifecycle.test.ts
pnpm --dir front-end check
pnpm --dir front-end test -- --run tests/differential
pnpm why cordis
git diff --check
```

Use the repository's actual differential test selector if the shown Vitest
selector is not how that suite is wired; report the exact replacement command.

## Execution evidence (2026-08-29)

- Pre-migration T01 gate: `pnpm --dir front-end exec vitest run src/__tests__/cordisMigration.test.ts src/__tests__/packageLifecycle.test.ts`
  passed exactly: `Test Files  2 passed (2)` and `Tests  7 passed (7)`.
- An initial strict-scope migration attempt (before the authorized test-import
  extension) failed before API assertions:
  `Error: Cannot find package '@deepseek-ai/cordis' imported from
  /home/softdream/Programming/gits/NNModelling/front-end/src/__tests__/cordisMigration.test.ts`.
  `packageLifecycle.test.ts` still ran (`Tests  3 passed (3)`). This was caused
  by the T01 test import being outside the original strict scope, not by an
  upstream Cordis API incompatibility; those changes were rolled back.
- With the test import explicitly authorized in scope, migrated all five
  `Context` imports to `cordis`, pinned `"cordis": "4.0.0-rc.8"`, and removed
  fork/peer lock entries. `pnpm --dir front-end install --frozen-lockfile`
  reported `- @deepseek-ai/cordis 4.0.1` and `+ cordis 4.0.0-rc.8`.
- Post-rollback T01 gate: `pnpm --dir front-end exec vitest run
  src/__tests__/cordisMigration.test.ts src/__tests__/packageLifecycle.test.ts`
  passed exactly: `Test Files  2 passed (2)` and `Tests  7 passed (7)`.
- Frontend check: `pnpm --dir front-end check` exited 0 with `0 errors` and 9
  pre-existing warnings.
- Real differential selector:
  `pnpm --dir front-end exec vitest run
  src/__tests__/modelConformance.test.ts
  src/__tests__/differentialGraphFuzz.test.ts` passed exactly: `Test Files  2
  passed (2)`, `Tests  5 passed (5)`.
- Dependency proof: `pnpm --dir front-end why cordis` reports only
  `cordis 4.0.0-rc.8` under `@nnmodelling/front-end`; FFF search finds no
  `@deepseek-ai/cordis` outside intentional plan/evidence text.
- `git diff --check` passes. The diff contains only T02 manifest/import/lockfile
  changes plus this evidence record; no lifecycle refactor appears. T03 is
  unblocked.

## Required handoff

Return dependency and import changes, lockfile proof, before/after T01 results,
the selected differential result, and a statement that T03 is or is not
unblocked.
