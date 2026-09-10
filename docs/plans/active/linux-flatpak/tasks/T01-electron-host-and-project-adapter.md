---
id: T01
kind: task
status: ready
plan: ../plan.md
role: frontend
depends_on: []
parallel_with: []
write_scope:
  - desktop/
  - front-end/src/project-workspace/
  - front-end/src/App.svelte
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
---

# Electron host and desktop project adapter

## Objective

Run the shared Svelte renderer in a secure Electron window and satisfy the
existing writable-project behavior through a typed desktop filesystem bridge.

## Context required

- [Initiative plan](../plan.md)
- [Desktop distribution decision](../../../knowledge/decisions/web-and-flatpak-desktop-distribution.md)
- `front-end/src/project-workspace/index.ts`
- `front-end/src/components/ProjectStart.svelte`
- `front-end/src/App.svelte`

## Invariants

- Web remains the default frontend host and continues using the File System
  Access API.
- Main/preload processes never own diagram, package, or type state.
- The bridge exposes only validated project capabilities and serializable data.
- Project creation cannot merge with or overwrite an existing directory.
- Autosaves stay ordered and failures remain visible.

## Allowed files

Only the paths in `write_scope`; lockfile changes must correspond exactly to
the new workspace package and dependencies.

## Out of scope

- Flatpak metadata and permissions.
- Bundled backend services.
- Changes to graph or type semantics.

## Work

1. Add failing host-adapter and security-boundary tests.
2. Add the Electron package, main process, preload bridge, and typed renderer
   declaration.
3. Inject a desktop project adapter only when the preload capability exists.
4. Build the frontend with a relative base and load it from the packaged app.
5. Exercise create, recursive read/write, autosave, collision, cancellation,
   and reopen behavior.

## Acceptance criteria

- [ ] Web and Electron select the correct adapter without source forks.
- [ ] Electron security preferences and navigation restrictions are tested.
- [ ] Desktop project operations preserve the accepted workspace contract.
- [ ] No change outside `write_scope`.

## Validation

```bash
pnpm --dir desktop test
pnpm --dir desktop build
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end build
```

## Required handoff

Return changed files, command results, security choices, project-workspace
compatibility evidence, and unresolved packaging risks.
