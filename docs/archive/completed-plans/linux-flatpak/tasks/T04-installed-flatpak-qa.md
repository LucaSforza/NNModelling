---
id: T04
kind: task
status: done
plan: ../plan.md
role: integration
depends_on: [T02, T03]
parallel_with: []
write_scope:
  - docs/plans/active/linux-flatpak/
  - docs/archive/completed-plans/linux-flatpak/
---

# Minimal installed Flatpak QA

## Objective

Prove the Flatpak can be built, installed, remains active through a bounded
launch smoke, and runs with the declared minimal permissions. Leave exhaustive
project-lifecycle QA as a documented manual pre-release follow-up for the user.

## Context required

- [Initiative plan](../plan.md)
- [Desktop distribution decision](../../../../knowledge/decisions/web-and-flatpak-desktop-distribution.md)
- [Testing strategy](../../../../knowledge/testing/strategy.md)

## Invariants

- QA uses the installed Flatpak, not only Electron development mode.
- Test data is isolated and does not modify an unrelated user project.
- A passing launch must not be reported as project-lifecycle evidence.

## Allowed files

Only plan status/evidence and final archival paths.

## Out of scope

- Feature expansion after acceptance passes.
- Flathub publication.

## Work

1. Build and install the Flatpak from a clean build directory.
2. Inspect effective permissions and perform a bounded installed-app launch.
3. Confirm the web production build and focused adapter tests still pass.
4. Record create/edit/save/reopen as manual pre-release QA that was not run.
5. Audit every acceptance criterion, mark tasks and plan done, retain concise
   evidence, and archive the completed initiative.

## Acceptance criteria

- [x] Installed application remains running through the bounded launch smoke test.
- [x] Flatpak has no undeclared broad filesystem permission.
- [x] Web build and focused project-adapter tests remain valid.
- [x] Exhaustive installed project-lifecycle QA is explicitly left unclaimed.
- [x] Initiative is archived only after all gates pass.

## Validation

```bash
flatpak run io.github.LucaSforza.NNModelling
flatpak info --show-permissions io.github.LucaSforza.NNModelling
pnpm --dir front-end build
git diff --check
```

## Required handoff

Return criterion-by-criterion evidence, artifact location, observed permissions,
remaining release-only work, and archive status.
