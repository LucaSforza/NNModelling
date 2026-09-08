---
id: T03
kind: task
status: ready
plan: ../plan.md
role: packages
depends_on: []
parallel_with: [T01, T02]
write_scope:
  - front-end/src/stereotype-authoring/
  - front-end/src/__tests__/stereotypeAuthoring.test.ts
---

# Generate valid model-owned stereotype resources

## Objective

Turn one typed authoring request into a deterministic, validated package
resource map and model-manifest entry with readable Lua and PyTorch scaffolds.

## Context required

- [Plan](../plan.md)
- [Frontend package contract](../../../../knowledge/contracts/package-type-system.md)
- `front-end/src/type-system/packages/types.ts`
- Current core and VAE package manifests, definitions, Lua rules and PyTorch
  entrypoints as syntax examples

## Invariants

- Generated data uses the canonical `Manifest`, `Definition`,
  `ParameterDefinition` and `ModelPackageReference` types.
- Identity, path, dependency and parameter validation happens before any
  filesystem or runtime mutation.
- Package IDs select no generated semantic special case; `kind` alone selects
  the safe scaffold family.
- The layer scaffold is an identity in both Lua inference and PyTorch runtime.
- Other kinds fail explicitly or use a genuinely kind-safe pass-through; they
  never fabricate an arbitrary training or tensor contract.

## Allowed files

- `front-end/src/stereotype-authoring/`
- `front-end/src/__tests__/stereotypeAuthoring.test.ts`

## Out of scope

- Svelte forms, filesystem access, runtime activation, source editing,
  datasets and changes to the package schema.

## Work

1. Define the authoring request and validate package ID/version, relative
   directory, display metadata, kind, dependencies and unique parameter names.
2. Support every current parameter type, including its existing conditional
   fields, while requiring explicit `top`/`bottom` position.
3. Render deterministic `manifest.json` and `stereotype.json` with fixed
   definition/Lua/PyTorch entrypoint filenames.
4. Render documented Lua and PyTorch templates. Prove the layer templates
   preserve input shape/dtype and construct `torch.nn.Identity` through the
   existing contracts.
5. Run generated resources through the real frontend package validators and
   cover every kind/parameter variant without adding package-ID switches.

## Acceptance criteria

- [ ] One request produces the four exact files and one matching relative model
      manifest entry.
- [ ] Every supported parameter definition serializes canonically.
- [ ] Duplicate names, invalid IDs/versions/paths/dependencies and invalid
      conditional fields fail before output.
- [ ] Generated layer Lua and PyTorch entrypoints are valid identity scaffolds.
- [ ] Other kinds are explicit and do not claim invented semantics.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/stereotypeAuthoring.test.ts
pnpm --dir front-end check
```

## Required handoff

Report the request schema, supported conditional fields, exact generated files,
kind-template behavior, changed files and current validation results.
