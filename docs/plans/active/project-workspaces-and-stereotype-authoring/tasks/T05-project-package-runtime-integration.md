---
id: T05
kind: task
status: ready
plan: ../plan.md
role: integration
depends_on: [T01, T02, T03, T04]
parallel_with: []
write_scope:
  - front-end/src/Diagram.svelte.ts
  - front-end/src/FlowCanvas.svelte
  - front-end/src/type-system/editor-runtime.ts
  - front-end/src/type-system/packages/
  - front-end/src/project-workspace/
  - front-end/src/__tests__/packageScopeLifecycle.test.ts
  - front-end/src/__tests__/modelScopedPackages.test.ts
  - front-end/src/__tests__/projectStereotypeCreation.test.ts
  - front-end/src/__tests__/packageBundle.test.ts
---

# Commit authored stereotypes through filesystem and model scope

## Objective

Connect the authoring form to one transactional operation that writes the new
package, updates `manifest.customPackages`, stages/commits the active model
scope and removes obsolete global installer machinery without breaking bundle
export or diagnostics.

## Context required

- [Plan](../plan.md)
- T01 workspace operations, T02 session callback, T03 generator, T04 UI
- Active model-scoped package plan and its final staged runtime seam
- `Diagram.importProjectJson`, `EditorTypeSystemRuntime.prepareModelScope()` /
  `commitModelScope()`, package export and diagnostic collections

## Invariants

- Reconcile the active model-scoped initiative before editing shared runtime
  files.
- DiagramCore alone commits model manifest and graph state.
- Filesystem resources, manifest entry, Cordis Fiber, registry rule, palette
  metadata and diagnostics succeed together or return to the previous state.
- The updated manifest is persisted through T01's sole ordered model writer;
  authoring must not race or bypass graph autosaves.
- Rollback removes only a directory proven newly created by this operation.
- Model-owned resources remain the exact backend package-export source.
- Core packages remain globally active and immutable.

## Allowed files

- The files and directories in `write_scope`; preserve unrelated tests and
  package-runtime behavior within shared directories.

## Out of scope

- Existing stereotype editing/removal, file watching, datasets, backend schema
  changes and a second package activation implementation.

## Work

1. Add the project-session authoring coordinator and stage generated resources
   through the existing model-scope validator before graph/runtime commit.
2. Write the exact package directory and updated model JSON, commit the staged
   scope once, refresh catalog/diagnostics/types and expose the new palette
   entry without reload.
3. Inject validation, permission, per-file write, model-write and activation
   failures; prove rollback of disk, manifest and runtime state and diagnose a
   rollback failure precisely.
4. Replace FlowCanvas's install/remove callbacks with the project-authoring
   callback.
5. Trace and remove no-longer-reachable IndexedDB external installer state,
   methods, types and tests while preserving core discovery and scoped bundle
   export.
6. Verify the generated Lua resource activates and generated PyTorch resource
   remains byte-for-byte available to the backend bundle seam.

## Acceptance criteria

- [ ] One form submission creates four files, one manifest entry, one active
      package scope transition and one visible palette entry.
- [ ] Reopening the project reproduces the same custom package and graph.
- [ ] Every injected failure preserves the previous usable project/runtime or
      reports exact manual recovery after rollback failure.
- [ ] No visible or callable global installer ownership remains without an
      explicit supported consumer.
- [ ] Package diagnostics and bundle export remain browser-authoritative and
      include the generated resources.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/projectStereotypeCreation.test.ts src/__tests__/packageScopeLifecycle.test.ts src/__tests__/modelScopedPackages.test.ts src/__tests__/packageBundle.test.ts
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir mcp-server test
```

## Required handoff

Report the commit/rollback order, removed installer ownership, exact runtime
transition count, changed files, current test output and scenarios reserved for
T06 browser verification.
