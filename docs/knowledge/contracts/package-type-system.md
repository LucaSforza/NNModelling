---
kind: knowledge
status: current
updated: 2026-08-22
---

# Frontend package type-system contract

NNModelling's frontend type system is package-driven. The browser owns package
activation and executes each package's Lua inference rule; the independent
`stereotype-lab` implementation remains the semantic reference used by tests,
not a production dependency.

The pinned reference design can be downloaded directly from GitHub:

- [type-system overview](https://raw.githubusercontent.com/LucaSforza/stereotype-lab/ef3efb1859b4a9c19227dd55aade65767fd4b1f5/design/type-system/README.md)
- [design goals](https://raw.githubusercontent.com/LucaSforza/stereotype-lab/ef3efb1859b4a9c19227dd55aade65767fd4b1f5/design/type-system/01-design-goals.md)
- [structured diagnostics](https://raw.githubusercontent.com/LucaSforza/stereotype-lab/ef3efb1859b4a9c19227dd55aade65767fd4b1f5/design/type-system/02-structured-diagnostics.md)
- [dtype system](https://raw.githubusercontent.com/LucaSforza/stereotype-lab/ef3efb1859b4a9c19227dd55aade65767fd4b1f5/design/type-system/03-dtype-system.md)
- [package specification](https://raw.githubusercontent.com/LucaSforza/stereotype-lab/ef3efb1859b4a9c19227dd55aade65767fd4b1f5/design/stereotype-specification/README.md)
- [NNModelling integration](https://raw.githubusercontent.com/LucaSforza/stereotype-lab/ef3efb1859b4a9c19227dd55aade65767fd4b1f5/design/nnmodelling-integration/README.md)

Agents may fetch these raw URLs for the full normative design. This document
records only the NNModelling-owned integration boundary.

## Current frontend boundary

- `DiagramCore` is the only authority for the live graph.
- Every frontend node has exact `data.package = {id, version, name}` identity.
  Display names never resolve packages.
- Bundled resources under `stereotype-packages/` provide one independently
  identified package per stereotype.
- `TypeSystemHost` activates definitions and isolated Lua inference rules in
  the browser. Production inference never invokes Python or the reference
  repository.
- Package schemas drive node kind, parameters, defaults, dtype controls and
  presentation. Inference must not switch on package IDs.
- Stored parameter values are semantic primitives, not legacy
  `{value, position}` wrappers.
- Browser RPC and the visible editor expose the same package-only graph and
  inference result.

## Tensor and result model

A successful semantic tensor contains only:

```ts
type TensorType = {
  shape: readonly (string | number)[]
  dtype: DType
}
```

Symbolic dimensions are nominal: equal names are equal variables, while the
frontend adds no equations, unification or symbolic broadcasting. Dtype is
always one canonical value. There is no `unknown` dtype, promotion or implicit
cast; `core.cast` performs explicit conversion.

Editor analysis distinguishes:

- unresolved inputs or required parameters;
- successful inference;
- expected semantic incompatibilities;
- host, activation or Lua runtime faults.

Unresolved editor state is not represented by a partial or fake tensor.
Expected errors and runtime faults remain distinct. Nested inference preserves
the innermost cause and adds compositional context frames; stable diagnostic
codes, multiple causes, warnings and source spans are not current requirements.

## Graph semantics

- Package `kind`, not package ID, determines input, layer, loss, join and
  subflow topology.
- Join inputs are ordered by `targetHandle`.
- A complete whole graph has exactly one terminal node. Incomplete editor
  graphs may still infer every locally reachable region whose dependencies are
  resolved.
- Dynamic stereotype parameters resolve an active package with the declared
  kind and version requirement. Composition remains package-driven.

## Verification authority

Observable type semantics are cross-validated against the pinned independent
`stereotype-lab` oracle through a versioned JSON protocol. Deterministic model
fixtures and property-based comparisons complement local tests of editor,
graph, persistence, transport and host behavior.

Broader deterministic model coverage, deeper property-based generation,
shrinking and a retained divergence corpus are future work recorded in
[`../../TODO.md`](../../TODO.md); they are not retroactive completion gates for
the frontend cutover.

## Explicit boundary

Package diagrams cannot yet compile, convert, train or run inference through
the Python backend. The future backend will independently load trusted
`pytorch.py` entrypoints, but its NNModelling design must be based on the
backend architecture that exists when that work begins. Do not design that
integration prematurely or use PyTorch as a type-inference fallback.

Legacy `TypeEngine`, `StereotypeCore`, repository `Stereotypes/`, wrapped
parameters and legacy editable diagrams are removed and have no compatibility
contract.
