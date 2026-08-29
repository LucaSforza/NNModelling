---
id: cordis-runtime-and-external-packages
kind: plan
status: ready
updated: 2026-08-29
areas:
  - architecture
  - frontend
  - mcp
  - packages
  - testing
---

# Upstream Cordis runtime and external stereotype packages

## Goal

Move the frontend type-system host from DeepSeek's Cordis fork to the upstream
`cordiverse/cordis` package, then use Cordis as the actual owner of package
services and package Fiber cleanup. On that foundation, let a user install a
complete stereotype package from a local directory, use its Lua inference in
the editor, include its Python resources in the existing package bundle, and
reopen diagrams that reference it by exact package ID and version.

The accepted product and lifecycle decisions are recorded in
[`local-package-runtime.md`](../../../knowledge/decisions/local-package-runtime.md).

## Current behavior

- The frontend imports `Context` from `@deepseek-ai/cordis@^4.0.1` in
  `front-end/src/type-system/host.ts`,
  `front-end/src/type-system/packages/loader.ts`, and the differential oracle
  adapter.
- `PackageRegistry` and `LuaPackageInferenceRuntime` are ordinary private
  objects passed to `PackageLoader`; they are not Cordis services.
- `PackageLoader` owns a second cleanup machine around Cordis: an `active`
  map, lease counters, dependency rollback, a loaded-rule disposer, registry
  unregistering, and a package Fiber disposer.
- `EditorTypeSystemRuntime.create()` discovers bundled packages and activates
  each one. There is no external package store or installation flow.
- Nodes persist `{id, version, name}` even though the display name belongs to
  the package definition. Package resources and local paths are not persisted.
- Package initialization failures are logged to the browser console. Node Lua
  faults can reach the Type Check panel, but host/package failures do not have
  one shared editor and MCP diagnostic contract.
- `buildPackageBundle()` accepts active package exports and already transports
  `pytorch.py`, but its export seam is shaped around bundled packages.

## Scope

- Migrate first from `@deepseek-ai/cordis` to an exact upstream `cordis`
  version and prove lifecycle compatibility before any Cordis refactor.
- Mount the registry and Lua runtime as typed Cordis services.
- Give every active package one Cordis Fiber and make Fiber-owned effects the
  sole cleanup owner for its rule, registry entry, and dependency leases.
- Preserve domain validation for exact identity, static dependency ranges,
  cycles, version conflicts, and inference recursion.
- Add a durable browser store for external package directories and a local
  directory installation UI.
- Persist only `{id, version}` package references in diagrams. Read the current
  optional `name` field during migration, ignore it, and omit it on the next
  save.
- Keep all bundled core packages mandatory and automatically active, whether
  or not the current diagram references them.
- Activate external packages at runtime and keep one active version per
  package ID in a Cordis context.
- Surface package/runtime fatal diagnostics in the editor below Type errors
  and through browser-backed MCP inspection.
- Keep inference working for graph regions unrelated to a failed external
  package.
- Export the exact external package resource closure, including its
  `pytorch.py`, through the existing package-bundle path.

## Non-goals

- Remote URLs, GitHub discovery, registries, marketplaces, or network install.
- Cordis loader configuration, HMR, events, or waterfall semantics.
- Using Cordis `inject` as a package-dependency resolver. A missing required
  host service or static package dependency must fail activation, not leave a
  Fiber silently pending.
- A general dependency solver, project lockfile, automatic dependency
  download, or silent version selection across ambiguous candidates.
- Hot reload of a selected directory or retaining a browser directory handle.
- Executing Python in the browser or using Python as an inference fallback.
- Redesigning the backend worker, trainer, or package-bundle protocol owned by
  the active `package-backend-standard` initiative.
- Supporting two Cordis implementations behind a permanent compatibility flag.

## Decisions and invariants

- Pin upstream `cordis` exactly to `4.0.0-rc.8`. This was the published
  `cordiverse/cordis` core version on 2026-08-29. Do not use a caret and do not
  opportunistically upgrade it during this initiative.
- T02, the dependency migration, must land and pass its gate before T03 changes
  lifecycle structure. This isolates dependency behavior from refactor behavior.
- `DiagramCore` remains the only mutable graph authority. Package installation
  and activation never create a second graph.
- The installed catalog owns immutable package bytes and metadata. The Cordis
  registry owns active rules. Diagram nodes own only exact `{id, version}`
  references. These stores must not be collapsed into one map.
- Store external packages by `id@version` in IndexedDB. Keep an internal digest
  and exact resolved static-dependency identities with the installed record;
  neither belongs in the diagram JSON.
- Installing the same `id@version` with identical bytes is idempotent. Different
  bytes under an existing `id@version` are rejected. Bundled IDs cannot be
  replaced or removed by an external package.
- A local installation is transactional: read one directory, normalize its
  package-relative files, validate the full package and its dependencies, then
  persist it. A failure leaves the previous store and active runtime unchanged.
- External packages must declare valid definition, Lua inference, and Python
  entrypoints, and all referenced files must exist. Preserve the complete
  package-relative resource map so helper files are not lost.
- Static dependencies must already be bundled or installed. Resolve each range
  to exactly one candidate at installation time and persist that exact
  resolution. Zero or multiple compatible candidates fail with an actionable
  diagnostic; there is no implicit highest-version policy.
- Multiple versions may be installed, but one Cordis context may activate only
  one version of an ID. A graph containing conflicting exact versions is
  diagnosed and not silently rewritten.
- Core activation is an editor bootstrap requirement. Try every core package so
  the UI can report all failures, but mark runtime readiness false and do not
  auto-create the Input node unless every core package is active.
- A successfully installed external package is activated immediately in the
  current session. On later startup, its metadata is available but its Lua rule
  is activated only when a user selects it or a loaded diagram references its
  exact identity.
- External package activation is sticky for the editor session. Do not add
  per-node reference counting. Removal is rejected while a package is active,
  referenced by the open diagram, or required by another installed package;
  a future session can remove it once those conditions no longer hold.
- Each active package has exactly one Cordis Fiber. Registry registration,
  loaded Lua rule disposal, and dependency lease release are registered as
  effects on that Fiber and unwind in reverse order. No second resource cleanup
  stack is allowed.
- A host service is mounted before package activation and verified directly.
  Service absence is a fatal activation error. `inject` is deliberately not
  used for this fail-fast contract.
- Public Cordis APIs only: do not inspect private Fiber/event internals.
- Package diagnostics are structured data, not console-only strings. At
  minimum they contain package ID/version when known, phase, severity,
  message, optional node ID, and a stable occurrence ID.
- A failed external package faults only nodes that reference it and downstream
  nodes that require their outputs. Independent graph regions continue to
  infer. A core bootstrap failure is a global runtime diagnostic.
- The browser remains the authority exposed by MCP. The MCP server remains a
  thin proxy and stores no package catalog or diagnostics of its own.
- Package ID must never select inference, topology, parameter, dtype, or
  backend behavior.

## Contracts and control flow

### State ownership

```text
bundled resources ─┐
                   ├─> InstalledPackageCatalog (immutable id@version records)
local directory ───┘               │
                                    ├─> editor metadata / package manager
diagram {id,version} references ────┤
                                    v
                          PackageActivationCoordinator
                                    │
                                    v
                         Cordis package Fiber (one/version)
                           ├─ registry effect
                           ├─ Lua-rule effect
                           └─ dependency-lease effects
                                    │
                      ┌─────────────┴──────────────┐
                      v                            v
             graph inference/diagnostics    package bundle export
                      │                            │
                      └──── browser authority ────┘
                                   │
                                   v
                              MCP thin proxy
```

### Installed package record

The implementation may refine names, but it must preserve this information:

```ts
type PackageKey = `${string}@${string}`

type InstalledPackageRecord = {
  readonly key: PackageKey
  readonly source: "bundled" | "external"
  readonly manifest: Manifest
  readonly definition: Definition
  readonly resources: ReadonlyMap<string, Uint8Array>
  readonly digest: string
  readonly resolvedDependencies: Readonly<Record<string, PackageKey>>
}
```

`source`, digest, resources, and dependency resolution are installation state,
not project state. Text decoding happens at the package-runtime/export seams;
the durable store retains exact bytes.

### Runtime states

```text
installed -> activating -> active -> disposed
                  │          │
                  └-> failed └-> failed (runtime fault)
```

- `installed` means validated bytes exist in the composed catalog.
- `active` means the exact package Fiber and rule are registered in the current
  Cordis context.
- `failed` retains a diagnostic and can be retried only through an explicit
  activation/install action; graph refresh alone must not create a retry loop.
- Disposing the editor context disposes package Fibers before host services.

### Diagram load

1. Parse and validate the JSON without mutating `DiagramCore`.
2. Canonicalize each package reference to `{id, version}`; accept and discard
   the current redundant `name` field.
3. Ask the runtime to reconcile all exact identities. Missing, ambiguous, or
   failed packages become diagnostics; they do not rewrite the graph.
4. Commit the valid graph once through `DiagramCore`.
5. Infer every reachable region whose active package dependencies are ready.
6. Return the same package/runtime diagnostics to the visible editor and MCP.

### Local directory installation

1. A browser directory input produces package-relative `File` objects.
2. Require exactly one package root and one root `manifest.json`.
3. Normalize paths and reject malformed directory shape before parsing content.
4. Parse the manifest and definition; verify Lua and Python entrypoints and the
   complete resource set.
5. Resolve every static dependency to exactly one existing `id@version`.
6. Compute the canonical digest.
7. Atomically persist the record, refresh the catalog, and activate it.
8. If activation fails, retain the valid installed record, mark activation
   failed, and show a fatal diagnostic. Invalid packages are never persisted.

### Forward and rollback strategy

- **Expand:** T01 adds dependency-independent characterization tests. No
  persistent or runtime contract changes.
- **Migrate:** T02 replaces the dependency and imports only. If its gate fails,
  restore the DeepSeek dependency/imports and lockfile; no data rollback exists.
- **Verify:** T02 proves activation, dependency order, idempotent lease release,
  Fiber disposal, Lua cleanup, and host disposal under upstream Cordis.
- **Contract:** T03 removes the duplicate cleanup owner only after T02 is green.
  Do not retain both implementations behind a flag.
- The external store starts at schema `nnmodelling-packages/v1`. Rolling back
  application code may leave that IndexedDB database unused; it must not corrupt
  diagram files or bundled package behavior.

## Task graph

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [T01](tasks/T01-characterize-cordis-contracts.md) | `migration-test` | — | — | dedicated frontend lifecycle tests | Behavior-preservation gate before dependency changes |
| [T02](tasks/T02-migrate-upstream-cordis.md) | `dependency-migration` | `T01` | — | frontend manifests, lockfiles, Cordis imports | Exact upstream Cordis works before refactor |
| [T03](tasks/T03-cordis-services-and-fibers.md) | `runtime` | `T02` | `T04` | host, loader, registry, Lua service, focused tests | Cordis services and one Fiber-owned cleanup path |
| [T04](tasks/T04-installed-package-catalog.md) | `storage` | `T02` | `T03` | catalog/types, bundled adapter, new IndexedDB store, focused tests | Composed immutable bundled/external catalog |
| [T05](tasks/T05-local-directory-installer.md) | `frontend-feature` | `T04` | — | installer use case, package-manager component, focused tests | Transactional local-directory installation |
| [T06](tasks/T06-runtime-reconciliation-and-project-refs.md) | `integration` | `T03`, `T04`, `T05` | — | editor runtime, Diagram/DiagramCore project seam, package identity tests | Core auto-activation and exact external runtime loading |
| [T07](tasks/T07-package-runtime-diagnostics.md) | `diagnostics` | `T03`, `T04`, `T06` | — | diagnostic model, scheduler, Diagram state, Sidebar, tests | Scoped fatal errors below Type errors |
| [T08](tasks/T08-mcp-and-package-bundle.md) | `transport` | `T06`, `T07` | — | browser RPC, MCP inspection, package bundle/export tests | Same diagnostics and external resources over MCP/backend bundle |
| [T09](tasks/T09-real-interface-verification.md) | `verification` | `T05`, `T06`, `T07`, `T08` | — | tests, fixtures, current knowledge and archive evidence | Real browser/MCP proof and initiative closure |

T03 and T04 are the only planned parallel pair. Their write scopes must remain
disjoint: T03 must not edit catalog/storage types owned by T04, and T04 must not
edit host/loader/service files owned by T03. If either task discovers a shared
contract change, stop parallel work, integrate one task, then resume the other.

## Integration and review gates

- Do not start T03 until the T02 upstream dependency gate is green.
- Review T02 as a dependency-only migration. Any lifecycle refactor in its diff
  blocks integration because it destroys migration attribution.
- Review T03 by resource ownership: every acquired rule, registry entry, and
  dependency lease must have one Fiber-owned disposer and no competing cleanup
  path.
- Review T04/T05 by state transitions: a failed validation must leave both the
  durable catalog and active runtime unchanged.
- Review T06 by authority: diagram import/export may coordinate package
  activation, but only `DiagramCore` commits graph state.
- Review T07 with a disconnected graph fixture containing one failing external
  branch and one valid core branch. The valid branch must still produce its
  tensor result.
- T08 must coordinate with `package-backend-standard` P02/P06. Reuse its
  current package-bundle schema and submission seam; do not duplicate backend
  runtime work or create a second bundle format.
- Any package-ID switch, silent version choice, hidden activation retry loop,
  second browser graph, or MCP-side catalog blocks completion.
- Preserve unrelated working-tree changes. Each task reports its exact diff and
  current test output before the orchestrator integrates it.

## Acceptance criteria

- [ ] `@deepseek-ai/cordis` and its fork-specific lockfile entries are absent;
      frontend production and oracle code import exact `cordis@4.0.0-rc.8`.
- [ ] The migration characterization suite passes before and after the import
      switch with no refactor mixed into the migration diff.
- [ ] Registry and Lua runtime are typed Cordis services mounted before package
      activation; a missing service produces a fatal activation error.
- [ ] Every active package has one Fiber and all package resource cleanup is
      owned by effects on that Fiber.
- [ ] Every bundled core package is activated at startup even when unused.
- [ ] A user can install one valid external package directory, see it in the
      editor, create a node from it, and obtain Lua type inference without a
      page reload.
- [ ] The installation survives a page reload; the external rule is activated
      on demand when selected or referenced.
- [ ] Invalid packages, missing dependencies, ambiguous dependency versions,
      cycles, duplicate changed `id@version`, and bundled-ID collisions fail
      without partial persistence or activation.
- [ ] Diagram JSON written by the editor stores only package ID and version.
      Current JSON containing `name` still opens and is canonicalized on save.
- [ ] Missing or failed external packages do not rewrite diagram references.
- [ ] One failed external branch reports faults while an independent valid
      branch continues to infer.
- [ ] Fatal package/runtime errors appear below Type errors in the editor and
      through MCP inspection with the same structured fields.
- [ ] The package bundle contains the exact external package identity and its
      complete resource map, including the declared Python entrypoint.
- [ ] Core packages cannot be replaced or removed; active/referenced/dependency
      packages cannot be removed.
- [ ] No Cordis loader, HMR, event, waterfall, or package-dependency `inject`
      mechanism is introduced.

## Final verification

Run from the repository root unless noted otherwise:

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir mcp-server test
pnpm --dir front-end test:integration:forward
git diff --check
git status --short
```

Use `.agents/skills/nnmodelling-mcp/SKILL.md` for the final browser-backed MCP
flows and `.agents/skills/verify-task/SKILL.md` before handoff. T09 defines the
required real-interface scenarios and the evidence to retain.

## Knowledge and archive impact

- Keep the accepted decision in
  `docs/knowledge/decisions/local-package-runtime.md` authoritative throughout
  implementation.
- When the initiative lands, update
  `docs/knowledge/contracts/package-type-system.md` with the installed/active/
  referenced ownership split and the diagnostic contract.
- Update `docs/knowledge/architecture/overview.md` with the external package
  flow only after the implementation is verified.
- Reconcile package-bundle wording with the current
  `package-backend-standard` decision without duplicating its backend design.
- Mark task files complete with actual commands/results, then move this entire
  plan directory to `docs/archive/plans/` after final verification.

## Upstream references

- [Cordis upstream repository](https://github.com/cordiverse/cordis)
- [Upstream core package manifest](https://github.com/cordiverse/cordis/blob/main/packages/core/package.json)
- [Published `cordis` package](https://www.npmjs.com/package/cordis)
- [Cordis primer](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer)

