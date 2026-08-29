---
kind: knowledge
status: implemented
updated: 2026-08-29
---

# Package type-system cutover

NNModelling replaced the legacy frontend type system with package-owned Lua
inference. The cutover is complete: all frontend nodes use exact package
identity and primitive parameter values; `TypeEngine`, `StereotypeCore`,
`Stereotypes/` and their compatibility paths are removed.

## Decision

- The frontend owns the package catalog, Cordis lifecycle, isolated Lua
  runtime, graph scheduling, dtype visualization and editor diagnostics.
- `DiagramCore` remains the only mutable graph authority.
- Each stereotype remains one independently identified and versioned package.
- Package definitions drive topology, parameters and presentation. Lua owns
  package-specific type semantics; NNModelling does not dispatch on package ID.
- Tensor types remain deliberately small: nominal string/number shape
  dimensions plus one canonical dtype.
- Missing graph inputs or parameters are unresolved editor state, not partial
  tensors. Expected semantic errors and host/runtime faults are distinct.
- Nested inference preserves its innermost semantic cause and adds ordered
  context. Stable codes, multiple causes, warnings and source spans are not
  current requirements.
- The independent `stereotype-lab` implementation is the semantic reference
  used by cross-validation. It is never a production dependency.
- Legacy saved diagrams are intentionally unsupported; identity is never
  guessed from a display name.

The NNModelling integration contract is
[`../contracts/package-type-system.md`](../contracts/package-type-system.md).

## Reference design

Use the pinned raw GitHub documents when semantic detail is needed. They can be
downloaded directly by an agent without cloning the repository:

- [design index](https://raw.githubusercontent.com/LucaSforza/stereotype-lab/ef3efb1859b4a9c19227dd55aade65767fd4b1f5/design/README.md)
- [package specification](https://raw.githubusercontent.com/LucaSforza/stereotype-lab/ef3efb1859b4a9c19227dd55aade65767fd4b1f5/design/stereotype-specification/README.md)
- [type system](https://raw.githubusercontent.com/LucaSforza/stereotype-lab/ef3efb1859b4a9c19227dd55aade65767fd4b1f5/design/type-system/README.md)
- [standard library](https://raw.githubusercontent.com/LucaSforza/stereotype-lab/ef3efb1859b4a9c19227dd55aade65767fd4b1f5/design/standard-library/README.md)
- [testing direction](https://raw.githubusercontent.com/LucaSforza/stereotype-lab/ef3efb1859b4a9c19227dd55aade65767fd4b1f5/design/testing/01-reference-oracle-and-differential-fuzzing.md)
- [NNModelling integration](https://raw.githubusercontent.com/LucaSforza/stereotype-lab/ef3efb1859b4a9c19227dd55aade65767fd4b1f5/design/nnmodelling-integration/README.md)

The reference specification is authoritative for type semantics. NNModelling's
KB remains authoritative for its browser, graph, persistence, UI and transport
integration.

## Current package policy

The implemented product still uses bundled packages. A later accepted decision
now defines the migration to upstream Cordis and complete local-directory
installation for external packages. See
[`local-package-runtime.md`](local-package-runtime.md) for that future contract
and its executable plan.

Remote discovery, download, marketplaces, a general dependency solver,
lockfiles and hot reload remain non-goals. This document continues to describe
the completed package type-system cutover until the external-package plan lands.

## Backend boundary

Trusted package `pytorch.py` factories remain the intended direction for the
future backend. No detailed NNModelling backend design is accepted yet. That
design must begin from the then-current compiler/runtime and the pinned
[PyTorch runtime contract](https://raw.githubusercontent.com/LucaSforza/stereotype-lab/ef3efb1859b4a9c19227dd55aade65767fd4b1f5/design/stereotype-specification/04-pytorch-runtime.md).

Until then, package graphs cannot compile, convert, train or run backend
inference, and PyTorch must not act as a type-inference fallback.

## Future evidence

Additional deterministic models and broader property-based cross-validation
are desired future work. Their generators, shrinking policy and CI budgets are
not designed here. See [`../../TODO.md`](../../TODO.md).
