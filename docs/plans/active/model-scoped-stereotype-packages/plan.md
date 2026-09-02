---
id: model-scoped-stereotype-packages
kind: plan
status: ready
updated: 2026-08-29
areas:
  - architecture
  - frontend
  - packages
  - backend
  - testing
---

# Model-scoped custom stereotype packages

## Goal

Make the active model the ownership boundary for custom stereotype packages.
The model JSON declares its complete custom package set through an inline
`manifest`; the editor loads only that set in addition to the global core
packages. Switching models replaces the custom scope, and the backend receives
the resulting package resources, including every required `pytorch.py`.

This plan refines the completed
[Cordis/external-package plan](../../../archive/completed-plans/cordis-runtime-and-external-packages/plan.md)
and is governed by the accepted
[model-scoped package decision](../../../knowledge/decisions/model-scoped-stereotype-packages.md).
It does not reopen the completed Cordis migration or installer work.

## Current behavior

- Package-native model JSON contains graph data but no model-owned package
  manifest.
- `EditorTypeSystemRuntime` composes a global core/external catalog and can
  leave external packages active independently of the model being edited.
- `DiagramCore.importProjectJson()` reconciles package identities from nodes,
  so an exact node reference can activate a package without a model-level
  ownership declaration.
- `core.reparameterize` and `core.kl-divergence` are distributed as bundled
  core packages even though they are used only by the VAE example.
- The package bundle already transports package resources and Python entrypoints,
  but example coverage currently resolves every diagram package from the global
  `stereotype-packages/` tree.

## Scope

- Add and validate the inline model `manifest` with model identity, metadata,
  and complete `customPackages` entries (`id`, `version`, `path`).
- Compose the active frontend catalog as immutable core packages plus the
  current model's validated local packages.
- Stage model loading and switching. A failed manifest/package validation or
  activation leaves the existing model and custom scope unchanged.
- Remove the previous model's custom package fibers, registrations, palette
  entries, inference rules, and runtime diagnostics after a successful switch.
- Keep core packages globally active and do not load undeclared installed
  packages or infer custom package ownership from node IDs/display names.
- Move the VAE Sampling/Reparameterize and KL divergence package directories
  out of `stereotype-packages/core/`, give them VAE-owned identities, and place
  them beside the VAE model bundle.
- Add `manifest.customPackages: []` to ResNet and ensure it has no model-local
  package resources. Add the VAE custom package declarations to the canonical
  complete VAE fixture; secondary VAE fixtures must also carry a manifest.
- Export model-local package resources through the existing package bundle
  closure. The backend receives resolved bytes and `pytorch.py`, never a model
  filesystem path.

## Non-goals

- A shared model-package library, marketplace, discovery service, or package
  deduplication policy.
- Activating every package stored in IndexedDB for every model.
- A new backend transport, Python execution model, Lua semantic rule, or
  package dependency algorithm.
- Rewriting the completed Cordis lifecycle or external installer behavior.
- Keeping backward compatibility for model JSON without a `manifest`; without
  an explicit custom set the loader cannot guarantee ownership isolation.

## Decisions and invariants

- The model JSON top-level `manifest` is required and is distinct from each
  package's `manifest.json`.
- The model manifest v1 shape is:

  ```ts
  type ModelManifest = {
    readonly schemaVersion: 1
    readonly id: string
    readonly version: string
    readonly name: string
    readonly description?: string
    readonly customPackages: readonly {
      readonly id: string
      readonly version: string
      readonly path: string
    }[]
  }
  ```

- `customPackages` is exhaustive. Core package identities are implicit and
  must not be repeated there.
- Each `path` is relative to the model bundle root, resolves to exactly one
  package directory, and cannot escape that root. The package's own manifest
  must match the declared exact identity.
- A model-local package may depend only on a core package or another package
  listed by the same model manifest. A missing or ambiguous dependency rejects
  the model before graph commit.
- Node references to a custom package must match the model manifest exactly.
  A node cannot cause global discovery or activation.
- The old and new custom scopes must not coexist in the active catalog. Core
  packages may remain shared and active throughout a switch.
- Model switch is transactional from the user's perspective: prepare the new
  scope and graph first, then replace the graph and dispose the old custom
  scope. On failure, preserve the prior state.
- `DiagramCore` remains the only graph authority. Package scopes coordinate
  loading but do not own graph mutations.
- The backend package bundle contains the package closure needed by the graph,
  including model-local `manifest.json`, definition, Lua, Python, and helper
  files. It contains no model-relative path as an executable instruction.
- No inference, topology, parameter, dtype, or backend behavior may branch on
  the package ID. Moving VAE packages changes only ownership and identity.

## Contracts and control flow

### Model bundle

The canonical example layout becomes model-owned rather than global:

```text
examples/diagrams/package/models/
├── resnet/
│   └── model.json
└── variational-autoencoder/
    ├── model.json
    └── packages/
        ├── sampling/
        │   ├── manifest.json
        │   ├── stereotype.json
        │   ├── inference.lua
        │   └── pytorch.py
        └── kl-divergence/
            ├── manifest.json
            ├── stereotype.json
            ├── inference.lua
            └── pytorch.py
```

The model manifest points to `packages/sampling` and
`packages/kl-divergence`. The ResNet manifest has an empty custom package list.
The existing example index and documentation are updated to the new paths;
the non-canonical VAE fixture is retained only if it is still useful and gets
its own explicit manifest.

### Runtime scope

```text
core catalog ──────────────────────────┐
                                       ├─> staged active model runtime
model manifest + package directories ──┘       core + model custom packages
                                                       │
                                                       ├─> DiagramCore graph
                                                       ├─> Lua inference
                                                       └─> backend bundle
```

1. Parse and validate the model manifest and graph without mutating the
   current `DiagramCore` state.
2. Resolve every model-local package path, validate package closure and exact
   identities, and compose it with the immutable core catalog.
3. Activate the staged custom scope and reconcile graph references against
   that scope.
4. Commit the new model graph and manifest through the existing DiagramCore
   import seam.
5. Dispose the previous model custom scope and resolve its diagnostics. The
   new palette contains only core plus current-model packages.
6. Export the active graph and resolved package closure through the existing
   bundle builder. Model-relative paths are resolved before transport.

If steps 1–3 fail, steps 4–5 do not run and the previous model remains active.
If a model has no custom packages, the custom scope is empty and only core
packages remain active.

## Task graph

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [T01](tasks/T01-model-manifest-contract.md) | `architecture` | — | — | model manifest types, parser, persistence tests | Validated inline model manifest contract |
| [T02](tasks/T02-scoped-runtime-lifecycle.md) | `frontend` | T01 | — | editor runtime, package catalog, Diagram import/switch, frontend tests | Exclusive current-model custom scope |
| [T03](tasks/T03-model-examples-and-package-relocation.md) | `packages` | T01 | T02 | example model bundles, VAE package resources, package tests | ResNet/core and VAE/custom ownership are correct |
| [T04](tasks/T04-backend-bundle-and-interface-verification.md) | `integration` | T02, T03 | — | package bundle/export tests, backend fixture tests, docs | Model-local Python resources reach the existing bundle |
| [T05](tasks/T05-real-interface-verification.md) | `verification` | T02, T03, T04 | — | browser/MCP evidence and plan archive | User-facing switching and isolation are proven |

T02 and T03 may proceed in parallel only after T01's manifest shape is stable.
T03 must not alter runtime lifecycle files owned by T02. T04 integrates the
resolved package source but must not create a second backend bundle protocol.

## Integration and review gates

- A model without `manifest` is rejected with a model-level diagnostic before
  any graph or package activation mutation.
- A manifest path traversal, duplicate package identity, package-manifest
  mismatch, missing entrypoint, or dependency outside the declared scope
  leaves the previous active model unchanged.
- Switching from VAE to ResNet removes VAE Sampling/KL from the palette,
  active registry, inference runtime, and diagnostics. Switching back reloads
  exactly those VAE packages.
- ResNet's model bundle and backend bundle contain no VAE custom package.
- VAE's backend bundle contains both VAE custom packages and their
  `pytorch.py` resources alongside every core package required by its graph.
- Package IDs are used only as data for exact identity and capability lookup;
  no package-specific inference or backend switch is introduced.
- Browser and MCP observe the same current graph, package catalog and
  diagnostics. The MCP server stores no model scope.
- Preserve the completed external-package behavior outside model-scoped
  loading and preserve unrelated working-tree changes.

## Acceptance criteria

- [ ] Every supported package-native model JSON has a validated inline
      `manifest` with a complete `customPackages` list.
- [ ] Core packages are active for every model; undeclared custom packages are
      never loaded implicitly.
- [ ] Model-local package paths are validated relative to the model bundle and
      cannot escape it.
- [ ] A successful model switch removes all previous custom registrations and
      exposes only the new model's custom package set.
- [ ] A failed model switch is transactional and preserves the previous graph,
      package scope, and diagnostics.
- [ ] ResNet declares no custom packages and uses only global core packages.
- [ ] VAE owns and loads Sampling/Reparameterize and KL divergence from its
      local package directories; neither remains in the global core catalog.
- [ ] The VAE bundle includes both local package Python entrypoints, while the
      ResNet bundle does not include them.
- [ ] Lua inference remains the frontend semantic authority and the backend
      continues to execute the existing package bundle contract.
- [ ] Focused unit tests, frontend gates, backend fixture tests, and real
      browser/MCP verification pass.

## Final verification

Run from the repository root unless a task says otherwise:

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir mcp-server test
cd converted && uv run pytest src/tests/test_package_runtime.py -q
git diff --check
git status --short
```

For the final model-switch and package-catalog checks, use
`.agents/skills/nnmodelling-mcp/SKILL.md` and
`.agents/skills/verify-task/SKILL.md`.

## Knowledge and archive impact

- Keep `docs/knowledge/decisions/model-scoped-stereotype-packages.md` as the
  authoritative accepted decision.
- Keep the package type-system, model-package contract, architecture overview,
  and external-package decision aligned with this scope.
- Retain this plan under `docs/plans/active/` until implementation and real
  interface verification are complete; then archive it with evidence.
