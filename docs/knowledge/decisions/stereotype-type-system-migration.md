---
kind: knowledge
status: current
updated: 2026-08-22
---

# Stereotype type-system migration

NNModelling will replace its current frontend `TypeEngine` with the semantic
type system specified and executed by `stereotype-lab`. The reference remains
an independent black-box oracle used by tests; it is not a production
dependency.

## Ownership and sequencing

- Type inference, the Cordis host, package-plugin lifecycle, Lua runtime, graph
  scheduling, and editor diagnostics belong to the frontend.
- The new engine is developed beside the deprecated engine only while the
  migration is incomplete. New semantics must never be added to the deprecated
  engine, and the coexistence seam must not become a permanent feature flag.
- Backend package loading is designed only after frontend semantic
  cross-validation passes. PyTorch is never an inference fallback.
- At the end of the overall frontend-and-backend migration, the deprecated
  engine and legacy stereotypes are deleted. Existing diagrams may be redrawn;
  no legacy project-format migration is required.

## Package and project identity

- Independently versioned packages live under `stereotype-packages/`, with one
  directory and one Cordis plugin per stereotype.
- New saved nodes carry the canonical package `id`, exact package `version`,
  and display `name`. The name is presentation metadata and never resolves a
  package.
- Loading requires the exact saved version to be active. There is no implicit
  upgrade, version range, solver, lockfile, installer, or hot reload in this
  phase.
- The frontend receives bundled package resources through a browser adapter;
  filesystem discovery must not leak into Lua or the semantic inference API.

## Type and editor states

- A semantic tensor type is a shape of nominal string/number dimensions plus
  one canonical dtype. Equal symbolic names are the same nominal variable;
  the frontend adds no constraints or unification beyond reference semantics.
- Dtype is intrinsic to `TensorType`. A package that lets the user select a
  dtype uses the dedicated declarative `type: "dtype"` control from the
  package schema, not NNModelling's legacy free-form parameter semantics.
- There is no `unknown` dtype and no implicit cast or promotion. `core.cast` is
  the explicit conversion operation.
- Editor state is separate from semantic tensor data. A node or edge may be
  unresolved, successfully inferred, invalid with an expected diagnostic, or
  failed because of a host/runtime fault.
- In an incomplete graph, the frontend infers every locally reachable region
  whose required inputs and parameters are resolved. Missing inputs or
  parameters remain unresolved and are never converted into a fake tensor.
- A complete DAG has exactly one terminal node. Zero or multiple terminals are
  incomplete editor states rather than complete type-invalid models.

## Diagnostics

- Expected inference failures and host/runtime faults are disjoint outcomes.
- An expected diagnostic preserves one innermost cause and an ordered list of
  semantic context frames. Propagation appends outer frames, so the stored
  order is innermost to outermost.
- Initial frames cover node/package invocation, subflow, iteration, branch,
  and referenced stereotype. Stable diagnostic codes, warnings, multiple
  causes, and source spans remain out of scope until required by evidence.
- Editor node IDs and presentation locations are adapter metadata, not part of
  the oracle's semantic diagnostic.

## Cross-validation

- The oracle and candidate run as independent processes behind a versioned,
  JSON-serializable protocol.
- The test configuration pins one oracle revision exactly. Local runs may use
  an explicitly supplied clone; CI obtains the same revision in an ignored
  test cache.
- Shared-package and product-package modes are both required. Every minimized
  divergence becomes a deterministic regression fixture.

Cross-validation is built in three cumulative layers:

1. **Reference unit-suite parity:** run the pinned reference Bun suite in its
   own repository and copy or adapt every frontend-semantic test case into the
   NNModelling candidate suite. Every reference case must be accounted for;
   adaptations must preserve the same inputs and observable assertions.
2. **Per-slice deterministic differential checks:** from the first package
   onward, send the same canonical scenario to independent oracle and candidate
   processes and compare normalized semantic results exactly.
3. **Graph differential fuzzing:** before frontend completion, generate complete
   DAGs and nested subflows, run the same graph-semantic scenario through both
   adapters, shrink every divergence, and retain the minimized case. Generation
   covers valid graphs and one targeted invalid mutation at a time.

The version 1 whole-graph oracle covers complete DAGs with exactly one terminal
node. Incomplete editor graphs are fuzzed separately: NNModelling's local graph
scheduler is checked as an editor property, while each semantic invocation it
does make is still compared with the oracle. An incomplete editor graph is not
presented to the oracle as a complete model.

## Reference-first reuse policy

Copying or adapting `stereotype-lab` is the default implementation strategy,
not an optional shortcut. Before writing an equivalent component, every task
must inspect its named reference sources and tests, then:

- copy code and package assets unchanged when browser/runtime boundaries allow;
- adapt only the host-facing boundary required by NNModelling;
- preserve reference test vectors and observable assertions;
- record a source-to-destination mapping and the reason for every substantial
  adaptation or deliberate non-copy in the task handoff.

Independent rewrites require a concrete reason such as browser resource
delivery, `DiagramCore` integration, or a normative design rule that the
reference implementation has not yet implemented. Normative `design/` remains
authoritative, so known oracle defects—especially fault flattening and missing
structured diagnostics—must not be copied merely for source similarity.

The executable work and frontend completion gate are defined in
[`../../plans/active/stereotype-type-system-frontend/plan.md`](../../plans/active/stereotype-type-system-frontend/plan.md).
