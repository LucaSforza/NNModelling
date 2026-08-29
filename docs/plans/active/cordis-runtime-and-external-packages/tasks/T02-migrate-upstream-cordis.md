---
id: T02
kind: task
status: ready
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

- [ ] `@deepseek-ai/cordis` has zero repository matches outside archived
      evidence that intentionally names the old dependency.
- [ ] `cordis@4.0.0-rc.8` is the only Cordis runtime in the relevant pnpm graph.
- [ ] T01 passes unchanged under upstream Cordis.
- [ ] Frontend checking and selected differential tests pass.
- [ ] No lifecycle refactor appears in the diff.

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

## Required handoff

Return dependency and import changes, lockfile proof, before/after T01 results,
the selected differential result, and a statement that T03 is or is not
unblocked.

