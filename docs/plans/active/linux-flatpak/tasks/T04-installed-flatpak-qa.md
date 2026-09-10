---
id: T04
kind: task
status: ready
plan: ../plan.md
role: integration
depends_on: [T02, T03]
parallel_with: []
write_scope:
  - docs/plans/active/linux-flatpak/
  - docs/archive/completed-plans/linux-flatpak/
---

# Installed Flatpak QA

## Objective

Prove the installed Flatpak satisfies the complete Linux project workflow and
close the initiative only from current evidence.

## Context required

- [Initiative plan](../plan.md)
- [Desktop distribution decision](../../../knowledge/decisions/web-and-flatpak-desktop-distribution.md)
- [Testing strategy](../../../knowledge/testing/strategy.md)

## Invariants

- QA uses the installed Flatpak, not only Electron development mode.
- Test data is isolated and does not modify an unrelated user project.
- A passing launch alone is not project-lifecycle evidence.

## Allowed files

Only plan status/evidence and final archival paths.

## Out of scope

- Feature expansion after acceptance passes.
- Flathub publication.

## Work

1. Build and install the Flatpak from a clean build directory.
2. Launch it, create a temporary project, edit the graph, observe a successful
   save, close, reopen the same directory, and verify the edit persisted.
3. Confirm the web production build and browser project workflow still pass.
4. Audit every acceptance criterion, mark tasks and plan done, retain concise
   evidence, and archive the completed initiative.

## Acceptance criteria

- [ ] Installed create/edit/save/reopen succeeds.
- [ ] Flatpak has no undeclared broad filesystem permission.
- [ ] Web build and browser workflow remain valid.
- [ ] Initiative is archived only after all gates pass.

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
