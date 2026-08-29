---
kind: decision
status: accepted
updated: 2026-08-29
---

# Upstream Cordis and local external package runtime

## Context

The frontend currently depends on DeepSeek's Cordis fork even though
NNModelling is not part of the DeepSeek harness. Its package loader also wraps
Cordis with a second resource-lifecycle mechanism. Bundled packages work, but
the product cannot install a stereotype package supplied by another author.

The owner has accepted a complete first external-package flow and selected a
local directory as its only installation source.

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
- Install external packages only from a browser-selected local directory in
  this release. Store validated immutable package bytes in IndexedDB by exact
  ID and version; do not persist a directory handle or local path.
- Preserve all package-relative files. An external package must provide valid
  definition, Lua inference, and Python entrypoints and becomes eligible for
  both editor inference and the package bundle.
- Diagrams persist only exact package ID and version. Display name, bytes,
  source, digest, and resolved static dependencies belong to the installed
  catalog. The current redundant persisted `name` field is accepted on read,
  ignored, and omitted on subsequent saves.
- Multiple versions may be installed, but one Cordis context activates only
  one version per ID. Static dependencies must resolve to exactly one already
  available candidate during installation; ambiguous or missing resolutions
  fail explicitly.
- A valid installed external package activates immediately in the current
  session and on demand in later sessions when selected or referenced by an
  opened diagram.
- Fatal host/package/runtime diagnostics are structured browser state shown in
  the editor below Type errors and returned through the MCP proxy. A failed
  external package affects its nodes and dependent graph region, while
  unrelated regions continue to infer.
- Cordis events, waterfall semantics, loader/HMR, and a general package registry
  or network installer are not part of this release.

## Consequences

- Installed, active, and referenced packages are three distinct states with
  separate owners.
- Package installation needs a durable browser store, a composed catalog, an
  activation coordinator, package-management UI, and transactional tests.
- Project loading becomes package-aware but does not acquire graph authority.
- The frontend package export seam must expose external resource bytes instead
  of assuming bundled source modules.
- A package remains installed when its activation fails, allowing the editor
  and MCP to report and retry the exact failure without rereading the directory.
- There is no automatic resolution choice when more than one installed package
  satisfies a dependency. A later package-manager design may add an explicit
  user choice without changing project references.

## Implementation

The executable work breakdown is archived at
[`../../archive/completed-plans/cordis-runtime-and-external-packages/plan.md`](../../archive/completed-plans/cordis-runtime-and-external-packages/plan.md).

The plan is complete. The implemented contract is recorded in
[`../contracts/package-type-system.md`](../contracts/package-type-system.md)
and verified in the plan's T09 evidence, including the visible local-directory
installer, IndexedDB reload behavior, exact on-demand activation, Lua
inference, MCP parity, and deterministic external bundle resources.
