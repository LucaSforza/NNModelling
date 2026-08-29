---
id: T06
kind: task
status: complete
plan: ../plan.md
role: integration
depends_on:
  - T03
  - T04
  - T05
parallel_with: []
write_scope:
  - front-end/src/type-system/editor-runtime.ts
  - front-end/src/Diagram.svelte.ts
  - front-end/src/core/DiagramCore.ts
  - front-end/src/core/types.ts
  - front-end/src/utils.ts
  - front-end/src/type-system/editor/package-ui.ts
  - front-end/src/__tests__/packageRuntimeReconciliation.test.ts
  - front-end/src/__tests__/diagramPersistence.test.ts
---

# Reconcile runtime packages and persist exact project references

## Objective

Connect the installed catalog, Cordis activation host, package manager, and
diagram persistence so core packages are always active and exact external
packages load at runtime without giving package code graph authority.

## Context required

- T03 service/Fiber handoff
- T04 composed catalog/store handoff
- T05 installer and PackageManager callback contract
- `DiagramCore` import/export and graph-change contracts
- current package node creation and editor package selection helpers

## Invariants

- `DiagramCore` is the only graph mutation authority.
- Project JSON writes package `{id, version}` only. `name` is derived from the
  active/installed definition and never resolves a package.
- Read current `{id, version, name}` nodes, discard `name`, and write the new
  canonical shape. Do not guess missing IDs or versions.
- Every bundled core package activation is attempted at bootstrap. Runtime is
  ready only when all succeed.
- Installed external metadata may be listed while inactive. Activation occurs
  after install, when selected for node creation, or when an imported diagram
  references it.
- One active version per ID. Conflicts are diagnostics, never silent swaps.
- Graph refresh does not repeatedly retry a failed activation.

## Work

1. Introduce an activation coordinator keyed by exact `id@version`, with
   in-flight deduplication and explicit installed/activating/active/failed
   states.
2. Bootstrap every bundled core record regardless of graph use. Aggregate core
   failures, mark runtime unready, and skip automatic Input creation unless all
   cores are active.
3. Connect successful install to one activation attempt and refresh available
   package metadata after persistence.
4. Activate an external exact identity before creating a node from the package
   manager/sidebar. Keep activation sticky for the session.
5. Split project parsing from graph commit. Canonicalize package identities,
   reconcile all exact references asynchronously, then commit the structurally
   valid graph once even if some referenced packages are unavailable.
6. Change package identity types, node creation, editor labels, and export so
   only ID/version persist. Use definition name when available and package ID as
   the missing-package fallback label.
7. Define removal preconditions: reject bundled, active, current-diagram
   referenced, and installed-dependent packages. Removal changes the store and
   available metadata atomically.
8. Ensure host disposal cancels/awaits in-flight activation and disposes active
   external Fibers before services.
9. Test bootstrap independent of graph use, on-demand activation, in-flight
   deduplication, exact-version conflict, failed-state retry policy, install then
   create, reload then activate, removal guards, old-name import, and canonical
   new export.

## Acceptance criteria

- [ ] All core packages are active before editor readiness and Input spawn.
- [ ] A valid newly installed external package can create a node immediately.
- [ ] After reload, installed metadata appears without eagerly activating every
      external package; selecting or importing activates the exact version.
- [ ] One activation request creates one package Fiber even under concurrent
      selection/import requests.
- [ ] A structurally valid diagram with a missing package still opens without
      its reference being rewritten.
- [ ] New project JSON contains no package display `name`.
- [ ] Current project JSON containing `name` remains readable.
- [ ] No package operation mutates nodes except through a DiagramCore method.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/packageRuntimeReconciliation.test.ts src/__tests__/diagramPersistence.test.ts
pnpm --dir front-end check
git diff --check
```

## Required handoff

Return the state-transition table, project schema migration behavior, removal
preconditions, exact test output, and any existing public API changed with its
callers updated.
