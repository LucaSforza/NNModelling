---
id: T03
kind: task
status: done
plan: ../plan.md
role: testing
depends_on: [T01]
parallel_with: [T02]
write_scope:
  - desktop/
  - front-end/src/__tests__/
  - docs2/
  - docs/knowledge/testing/
  - docs/knowledge/operations/
---

# Desktop tests and user documentation

## Objective

Cover the desktop host boundary and document Linux Flatpak installation,
project access, remote backend use, and source-build verification.

## Context required

- [Initiative plan](../plan.md)
- [Testing strategy](../../../../knowledge/testing/strategy.md)
- [Local operations](../../../../knowledge/operations/local-stack.md)

## Invariants

- Tests prove shared behavior rather than duplicating frontend semantic suites.
- Documentation does not claim that the backend is bundled.
- Browser instructions remain valid.

## Allowed files

Only the paths in `write_scope`.

## Out of scope

- Distribution publishing and auto-update.
- Semantic changes to packages or diagrams.

## Work

1. Test preload allowlists, input validation, host selection, and filesystem
   error mapping.
2. Document local Flatpak installation, launch, project access, permissions,
   backend connectivity, and bundle regeneration.
3. Add the installed-application workflow to the KB testing contract and the
   build/run procedure to operations.

## Acceptance criteria

- [x] Desktop tests fail on an unsafe or incompatible bridge.
- [x] User and operator documentation matches the built artifact.
- [x] Existing web documentation remains correct.
- [x] Testing and documentation changes remain scoped to the initiative.

## Validation

```bash
pnpm --dir desktop test
pnpm --dir front-end test
pnpm run docs
```

## Required handoff

Return coverage added, documentation locations, exact validation results, and
any installed-workflow step reserved for T04.
