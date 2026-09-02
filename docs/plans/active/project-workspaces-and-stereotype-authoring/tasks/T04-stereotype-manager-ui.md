---
id: T04
kind: task
status: ready
plan: ../plan.md
role: frontend
depends_on: [T03]
parallel_with: []
write_scope:
  - front-end/src/components/PackageManager.svelte
  - front-end/src/components/StereotypeForm.svelte
  - front-end/src/components/ParameterForm.svelte
  - front-end/src/styles/package-manager.css
  - front-end/src/__tests__/packageManager.test.ts
  - front-end/src/__tests__/stereotypeForm.test.ts
---

# Replace package installation with project stereotype authoring

## Objective

Turn the Packages drawer into a Stereotypes manager that lists core/current
project packages and emits one validated stereotype-authoring request through
a form with repeatable parameter mini-forms.

## Context required

- [Plan](../plan.md)
- T03 authoring request and validation contract
- `PackageManager.svelte`, `package-manager.css`, Sidebar package presentation
- Current `ParameterDefinition` union

## Invariants

- Core entries are visible and read-only.
- Custom entries come only from the active model scope.
- The UI emits domain input; it does not write files, mutate DiagramCore or
  activate packages directly.
- Each parameter row has a unique name, canonical type and explicit position.
- Type changes clear fields that are invalid for the new variant rather than
  leaving hidden stale values.

## Allowed files

- The files in `write_scope` only.

## Out of scope

- Filesystem/runtime operations, existing package editing/removal, embedded
  code editors, datasets and custom schema extensions.

## Work

1. Rename the visible surface to Stereotypes and remove install-directory and
   remove-installed callbacks/messages.
2. List immutable core and current-project custom stereotypes distinctly.
3. Add the package form for identity, version, name, description, kind, color,
   size, directory and dependencies with safe defaults.
4. Add keyed parameter rows with add/remove/reorder, type, name, position and
   the canonical conditional fields for every supported type.
5. Validate through T03, preserve form input on rejection, prevent double
   submission and expose busy/success/error states accessibly.

## Acceptance criteria

- [ ] No global install/remove affordance remains in the manager.
- [ ] Core and active-project custom stereotypes are labelled correctly.
- [ ] Parameter rows support all canonical variants, explicit position and
      stable reorder/remove behavior.
- [ ] Invalid input is actionable and does not discard the user's draft.
- [ ] One successful submission emits one canonical authoring request.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/packageManager.test.ts src/__tests__/stereotypeForm.test.ts
pnpm --dir front-end check
```

## Required handoff

Report the visible interaction, supported fields, callback contract, changed
files, exact test output and any accessibility limitation for real-interface QA.
