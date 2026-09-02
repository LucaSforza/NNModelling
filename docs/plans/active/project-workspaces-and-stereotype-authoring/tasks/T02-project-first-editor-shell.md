---
id: T02
kind: task
status: ready
plan: ../plan.md
role: frontend
depends_on: [T01]
parallel_with: [T03]
write_scope:
  - front-end/src/App.svelte
  - front-end/src/FlowCanvas.svelte
  - front-end/src/utils.ts
  - front-end/src/components/ProjectStart.svelte
  - front-end/src/components/ProjectForm.svelte
  - front-end/src/styles/project-start.css
  - front-end/src/__tests__/projectShell.test.ts
  - front-end/src/__tests__/diagramPersistence.test.ts
---

# Make the editor project-first and automatically persistent

## Objective

Show New/Open before the editor, create the model manifest from a form, mount
one Diagram only after a workspace opens, display the active model name and
persist accepted graph changes automatically.

## Context required

- [Plan](../plan.md)
- T01 workspace API
- `front-end/src/App.svelte`, `FlowCanvas.svelte`, `Diagram.svelte.ts`
- `DiagramCore.onGraphChanged`, `exportToJson()` and model import contract

## Invariants

- Training-log windows retain their dedicated route and do not show the project
  chooser.
- No Diagram or Svelte Flow editor exists before a successful project choice.
- Model ID, version, name and description use the canonical manifest validator.
- New-project creation never writes to an existing child.
- Automatic persistence observes accepted DiagramCore mutations and reports
  the writer's real state.

## Allowed files

- The files listed in `write_scope` only.

## Out of scope

- Stereotype forms, package runtime mutation, dataset selection and persistent
  recent-project state.

## Work

1. Add New/Open startup states and error/cancellation handling.
2. Build the new-project form with model identity, version, name and optional
   description; generate schema v1 and an empty custom set.
3. Open imported models through the existing staged bundle-aware import seam.
4. Move editor construction behind a successful workspace session and preserve
   normal core bootstrap/Input creation.
5. Remove Save JSON, Load JSON and Load bundle controls; display the project
   name and automatic-save state in the editor toolbar.
6. Subscribe automatic persistence to accepted graph changes without adding a
   second graph store or save loop.

## Acceptance criteria

- [ ] Startup and training-log routes render the correct mutually exclusive
      surface.
- [ ] Valid new/open transitions mount exactly one editor; failure leaves the
      chooser usable.
- [ ] Project name and honest saving/saved/error state are visible.
- [ ] Standalone JSON controls are absent.
- [ ] Rapid accepted mutations persist newest state through T01's writer.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/projectShell.test.ts src/__tests__/diagramPersistence.test.ts
pnpm --dir front-end check
```

## Required handoff

Report component states, Diagram lifetime, autosave subscription ownership,
changed files, exact test output and the callback/session seam required by T05.
