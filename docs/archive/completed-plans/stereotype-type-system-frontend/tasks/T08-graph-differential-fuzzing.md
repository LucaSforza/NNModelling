---
id: T08
kind: task
status: done
plan: ../plan.md
role: testing
depends_on: [T07]
parallel_with: []
write_scope:
  - front-end/tests/differential/
  - front-end/package.json
  - pnpm-lock.yaml
  - docs/knowledge/contracts/
  - docs/plans/active/stereotype-type-system-frontend/evidence/
---

# Cross-validate three representative graphs against the oracle

## Objective

Execute deterministic Transformer, variational-autoencoder and ResNet semantic
graphs against independent `stereotype-lab` and NNModelling adapters, compare
exact observable results, and produce saved editor diagrams that exercise the
same package identities. Generative differential fuzzing is explicitly
deferred to the next frontend testing milestone.

## Context required

- Read the complete initiative and all task handoffs/reuse ledgers.
- In `stereotype-lab`, read all of `design/testing/`,
  `design/type-system/02-structured-diagnostics.md`, core packages, Bun tests,
  and representative `src/models/` fixtures.
- Reuse/adapt reference package fixtures and deterministic examples as fuzzer
  seeds. Do not invent alternative package semantics in the generator.

## Deterministic semantic graphs

The versioned wire graph is minimal semantic data, independent of Svelte and
NNTree. The three fixtures are complete acyclic graphs with exactly one
terminal, exact package IDs/versions, ordered join handles, symbolic dimensions
and canonical dtypes. The product ResNet additionally covers NCHW convolution,
normalization, activation, pooling, flattening and classification.

## Comparison

- Normalize canonical JSON and compare successful tensor results exactly.
- Compare structured expected causes and ordered context frames exactly.
- Compare fault category and semantic fault metadata without requiring equal
  internal stack traces or class names.
- Preserve the exact protocol and package identities so these fixtures remain
  seeds for the later generator and shrinker.

## Independent properties

Differential equality is supplemented by properties that can detect a copied
bug on both sides: Linear rank/unaffected dimensions, Add permutation,
Concat size sums, Repeat sequential composition, Horizontal Repeat branch/join
behavior, innermost-cause preservation, dtype preservation, Input equality,
Fork identity, Cross Entropy scalar output, Cast conversion, and Embedding
integer-to-floating selection.

## Acceptance criteria

- [x] Candidate and oracle run as independent processes using protocol v2.
- [x] Transformer, variational-autoencoder and reference-compatible ResNet
  scenarios have zero divergences.
- [x] Product ResNet passes the candidate scheduler through a realistic NCHW
  residual graph.
- [x] All four semantic fixtures survive editor export/import and retain exact
  package ID, version and display name.
- [ ] Seeded generation, invalid mutations, shrinking, nested subflows and
  retained fuzz regressions are deferred to the future fuzzing milestone.

## Validation

```bash
pnpm --dir front-end test:type-system:models
pnpm --dir front-end exec vitest run src/__tests__/packageEditorModels.test.ts
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end build
git diff --check
```

## Required handoff

Return protocol/fixture schemas, shared/product outcomes and live-editor
evidence. State explicitly that this is the requested three-model milestone,
not the full frontend parity or fuzzing gate; no backend plan is opened.
