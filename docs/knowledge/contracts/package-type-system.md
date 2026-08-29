---
kind: knowledge
status: current
updated: 2026-08-29
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
- Every frontend node has exact `data.package = {id, version}` project identity.
  Display names are derived from the installed definition and never resolve
  packages. Current imports may contain a redundant `name`; it is ignored and
  omitted on the next save.
- Bundled resources under `stereotype-packages/` provide one independently
  identified core package per stereotype. Model-owned packages are supplied by
  the current model manifest and are not part of this global core catalog.
- `TypeSystemHost` activates definitions and isolated Lua inference rules in
  the browser. Production inference never invokes Python or the reference
  repository.
- Package schemas drive node kind, parameters, defaults, dtype controls and
  presentation. Inference must not switch on package IDs.
- Stored parameter values are semantic primitives, not legacy
  `{value, position}` wrappers.
- Browser RPC and the visible editor expose the same package-only graph and
  inference result.

## Project-owned custom packages

- Bundled core records are loaded and activated at editor bootstrap. The
  runtime is ready, and the automatic `Input` node is created, only after all
  bundled packages activate successfully.
- Custom stereotype packages live under the writable project directory and
  are declared exhaustively by `manifest.customPackages`. They are never
  installed into or discovered from a global browser catalog.
- The visible Stereotypes manager lists immutable core packages and the current
  project's exact custom set. Creating a stereotype writes its package
  manifest, definition, Lua rule and PyTorch entrypoint inside the project,
  updates the model manifest and stages the resulting package scope.
- The project catalog retains every declared helper resource and exact resolved
  dependency identity for deterministic package-bundle export. The bundle
  contains `pytorch.py` and all package-relative helper files byte-for-byte.
- Invalid authoring input, project directories or package scopes are rejected
  transactionally. The editor and browser-backed MCP expose the same structured
  runtime diagnostics; a failed package branch faults only its dependent graph
  region.
- The former local-directory installer and IndexedDB external-package ownership
  path are superseded by the accepted
  [writable project decision](../decisions/project-workspaces-and-stereotype-authoring.md)
  and are scheduled for removal by its active implementation plan.

## Model-scoped package loading

- A package-native model JSON has a required top-level `manifest` with model
  identity and a complete `customPackages` list. Each entry contains an exact
  package ID/version and a model-relative package directory.
- The active editor scope is `core + current-model-custom`. Core packages are
  automatically active; no undeclared package is searched or added
  to the palette.
- Model package manifests and paths are validated before `DiagramCore` commits
  the model. A failed model switch leaves the previous graph and custom scope
  unchanged. A successful switch disposes the previous custom fibers,
  registrations and runtime diagnostics.
- The backend bundle resolves model-relative resources before transport and
  includes each package's declared Python entrypoint and complete helper-file
  closure. The backend never receives a filesystem path from the model
  manifest.

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

The current branch contains an experimental package compiler, trainer and
wheel path, but they do not yet satisfy the accepted backend execution
contract. The backend loads `pytorch.py` independently inside its worker;
Python remains outside frontend type inference and cannot be used as a Lua
fallback.

The accepted backend integration changes completion from one structural
terminal to role-aware prediction and objective terminals. That future
contract, including explicit `kind: "output"` and declarative loss bindings,
is recorded in the
[prediction/objective program decision](../decisions/prediction-objective-programs.md).
Until its implementation lands, the single-terminal rule above describes the
current frontend rather than the accepted training boundary.

Legacy `TypeEngine`, `StereotypeCore`, repository `Stereotypes/`, wrapped
parameters and legacy editable diagrams are removed and have no compatibility
contract.
