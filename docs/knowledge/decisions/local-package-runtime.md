---
kind: decision
status: accepted
updated: 2026-08-29
---

# Upstream Cordis package runtime

## Context

NNModelling migrated from the DeepSeek Cordis fork to upstream Cordis and made
Cordis Fibers the sole lifecycle owner for active package registrations, Lua
rules and dependency leases. That runtime foundation remains current.

An intermediate product iteration added a visible local-directory installer
and IndexedDB package ownership. The later accepted
[model-scoped package decision](model-scoped-stereotype-packages.md) and
[writable project workspace decision](project-workspaces-and-stereotype-authoring.md)
supersede that ownership model: custom stereotypes now belong to the current
project, while the global catalog contains only immutable core packages.

## Decision

- Use upstream `cordiverse/cordis`, published as `cordis`, pinned exactly to
  `4.0.0-rc.8`. Migrate the dependency before refactoring lifecycle code.
- Mount the active package registry and Lua inference runtime as Cordis
  services. Validate required services directly and fail activation when they
  are absent; do not use `inject` to leave packages pending.
- Give each active package one Cordis Fiber. Fiber-owned effects are the only
  owner of registry removal, Lua rule cleanup, and dependency lease release.
- Keep bundled core packages mandatory, immutable, and automatically active at
  editor startup even when the diagram does not use them.
- Preserve every package-relative file. A model-owned custom package provides
  a valid definition, Lua inference and Python entrypoint and is eligible for
  editor inference and the resolved backend package bundle.
- Diagrams persist only exact package ID and version. Display metadata and
  package bytes are resolved from immutable core resources or the current
  project's declared package directory. Filesystem handles and absolute paths
  are never persisted.
- One Cordis context activates only one version per package ID. Static
  dependencies resolve to exactly one core or current-project package;
  ambiguous or missing resolutions fail explicitly.
- A model load does not discover packages by display name, package ID, prior
  installation or availability. Model custom packages must be declared in the
  model manifest and supplied by its model-relative directories; their active
  scope is replaced transactionally on model switch.
- Fatal host/package/runtime diagnostics are structured browser state shown in
  the editor below Type errors and returned through the MCP proxy. A failed
  model-owned package affects its nodes and dependent graph region, while
  unrelated regions continue to infer.
- Cordis events, waterfall semantics, loader/HMR, and a general package registry
  or network installer are not part of this release.

## Consequences

- Core resource ownership, current-project resource ownership, active runtime
  state and node references remain distinct. They are not collapsed into one
  map or inferred from one another.
- Project loading is package-aware but does not acquire graph authority.
- The frontend package export seam exposes the complete resolved project
  resource closure instead of assuming globally bundled source modules.
- There is no automatic discovery or version choice outside the current model
  manifest. Third-party acquisition requires a separate future design.

## Implementation

The completed Cordis migration and lifecycle evidence is archived at
[`../../archive/completed-plans/cordis-runtime-and-external-packages/plan.md`](../../archive/completed-plans/cordis-runtime-and-external-packages/plan.md).

The current project ownership replacement is defined by
[`../../plans/active/project-workspaces-and-stereotype-authoring/plan.md`](../../plans/active/project-workspaces-and-stereotype-authoring/plan.md).
That initiative removes transitional installer/IndexedDB callers while
preserving the Cordis lifecycle, Lua inference, diagnostics, MCP parity and
deterministic bundle-resource contracts recorded in
[`../contracts/package-type-system.md`](../contracts/package-type-system.md).
