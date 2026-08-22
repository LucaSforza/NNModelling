---
id: T10
kind: task
status: completed
plan: ../plan.md
role: frontend
depends_on: [T09]
parallel_with: []
---

# Make package identity the only frontend node contract

## Objective

Remove the legacy/new bifurcation at the graph and editor boundaries. Every
node accepted, created, imported, saved, or mutated by the frontend must carry
exact `data.package = {id, version, name}` and primitive parameters validated
from the active package definition.

## Scope

- Make package identity required in frontend node types and graph mutations.
- Remove `StereotypeCore`, legacy dropdowns, legacy parameter wrappers, and all
  branches selected by the presence or absence of `data.package`.
- Make the package result the sole `Diagram` inference result and rename it to
  `typeResult` after the old property is gone.
- Delete calls to `TypeEngine.infer`; graph changes schedule only package/Lua
  inference.
- Preserve `DiagramCore` as the single live graph authority and preserve exact
  notification, undo/redo, subflow, containment, and ordered-handle behavior.
- Reject legacy saved nodes clearly on import. Do not convert or guess package
  identity from a display name.

## Required evidence

- New-format create/edit/export/import tests cover exact package identity and
  primitive values.
- Negative tests reject a node without package identity and a wrapped
  `{value, position}` parameter.
- Live editor QA proves one package model can be created, edited, saved, and
  reloaded with identical inferred shape/dtype and no legacy control surface.
- Existing candidate/oracle deterministic cross-validation remains green.

## Excluded

- Browser RPC migration, physical deletion of all legacy files, backend
  compilation, and compatibility conversion.

## Rollback

Revert T10 as one commit. Saved package fixtures remain valid because the task
does not change package identity or semantic values.
