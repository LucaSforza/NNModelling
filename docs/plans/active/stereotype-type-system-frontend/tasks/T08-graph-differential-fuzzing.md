---
id: T08
kind: task
status: draft
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

# Differential-fuzz complete graphs against the oracle

## Objective

Generate complete DAGs and nested subflows, execute the same canonical scenario
against independent `stereotype-lab` and NNModelling adapters, compare exact
observable results, shrink divergences, and retain minimized regressions. This
is the final frontend gate before backend planning.

## Context required

- Read the complete initiative and all task handoffs/reuse ledgers.
- In `stereotype-lab`, read all of `design/testing/`,
  `design/type-system/02-structured-diagnostics.md`, core packages, Bun tests,
  and representative `src/models/` fixtures.
- Reuse/adapt reference package fixtures and deterministic examples as fuzzer
  seeds. Do not invent alternative package semantics in the generator.

## Generated semantic graphs

The versioned wire graph is minimal semantic data, independent of Svelte and
NNTree. Generation varies:

- complete acyclic topology with exactly one terminal;
- package IDs/versions, all five kinds, valid cardinalities and ordered join
  handles;
- numeric/symbolic shapes, canonical dtypes, defaults and boundary parameters;
- nested subflows, repeat counts, branches, dynamic joins and diagnostic paths;
- activation/lease sequences and compatible/incompatible selected packages.

Valid graphs are generated first. Invalid graphs are derived by one targeted
mutation, such as a dtype mismatch, rank/dimension boundary, wrong parameter,
wrong kind/version, missing activation, or incompatible nested branch. Random
invalid JSON and random Lua source are excluded.

## Comparison and shrinking

- Normalize canonical JSON and compare successful tensor results exactly.
- Compare structured expected causes and ordered context frames exactly.
- Compare fault category and semantic fault metadata without requiring equal
  internal stack traces or class names.
- Shrink node/edge count, tensor rank/dimensions, parameter magnitudes,
  package count, subflow depth, branch count and operation sequence.
- Store seed, original/minimized scenario, oracle/candidate/protocol/package
  identities, and both results. Every minimized divergence becomes a fixed
  regression before the gate can pass.

Incomplete editor graphs have a separate generator. It checks NNModelling's
local reachability/unresolved-state properties and compares each actual package
invocation with the oracle, but does not mislabel the incomplete graph as a
complete oracle scenario.

## Independent properties

Differential equality is supplemented by properties that can detect a copied
bug on both sides: Linear rank/unaffected dimensions, Add permutation,
Concat size sums, Repeat sequential composition, Horizontal Repeat branch/join
behavior, innermost-cause preservation, dtype preservation, Input equality,
Fork identity, Cross Entropy scalar output, Cast conversion, and Embedding
integer-to-floating selection.

## Acceptance criteria

- [ ] Bounded CI and extended local profiles are deterministic by seed and run
  both shared-package and product-package modes.
- [ ] Generated complete graphs cover every kind, core package, composition
  form, canonical dtype, and targeted-invalid category in the coverage ledger.
- [ ] Candidate and oracle have zero untriaged divergences.
- [ ] Every discovered divergence is minimized and retained as a deterministic
  regression with full identities and outcomes.
- [ ] Independent properties pass and can fail when their invariant is
  deliberately violated in a test fixture.
- [ ] Incomplete-graph fuzzing preserves local inference without treating the
  graph as a complete oracle model.

## Validation

```bash
pnpm --dir front-end test:stereotype-conformance
pnpm --dir front-end test:stereotype-fuzz -- --profile ci
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end test:integration:smoke
git diff --check
```

## Required handoff

Return generator/protocol schemas, seeds, coverage ledger, shrink results,
retained corpus, shared/product outcomes, independent-property results, and an
explicit statement that the frontend gate passes before any backend plan is
opened.
