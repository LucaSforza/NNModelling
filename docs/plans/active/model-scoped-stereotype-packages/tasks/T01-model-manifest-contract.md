---
id: T01
kind: task
status: ready
plan: ../plan.md
role: architecture
depends_on: []
parallel_with: []
write_scope:
  - front-end/src/core/types.ts
  - front-end/src/core/DiagramCore.ts
  - front-end/src/__tests__/diagramPersistence.test.ts
  - front-end/src/__tests__/modelConformance.test.ts
---

# Define and validate the inline model manifest

## Objective

Introduce the required model `manifest` schema and a parsing/persistence seam
that validates model identity, exact custom package references, and
model-relative paths before a graph mutation.

## Context required

- [Model-scoped package decision](../../../../knowledge/decisions/model-scoped-stereotype-packages.md)
- [Frontend package contract](../../../../knowledge/contracts/package-type-system.md)
- `DiagramCore` project import/export and current package identity types

## Invariants

- `manifest` is distinct from package `manifest.json`.
- `customPackages` is exhaustive; no default package discovery is allowed.
- Paths are relative and remain inside the model bundle root.
- Model parsing does not mutate `DiagramCore` on failure.

## Work

1. Add the model manifest type and strict validator.
2. Parse the manifest together with the graph and preserve it through model
   serialization.
3. Reject absent/invalid manifests, duplicate entries, path traversal, and
   malformed exact identities with actionable diagnostics.
4. Add persistence and conformance tests for empty and non-empty custom sets.

## Acceptance criteria

- [ ] Valid ResNet-like and VAE-like manifests parse deterministically.
- [ ] Invalid manifests fail before graph state changes.
- [ ] Export/import preserves model metadata and custom package descriptors.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/diagramPersistence.test.ts src/__tests__/modelConformance.test.ts
pnpm --dir front-end check
```

## Required handoff

Report the schema, validation errors, changed files, exact test results, and
any model-source resolver assumption needed by T02.
