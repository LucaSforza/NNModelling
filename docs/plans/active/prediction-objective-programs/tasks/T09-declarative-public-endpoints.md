---
id: T09
kind: task
status: in_progress
plan: ../plan.md
role: architecture
depends_on: [T05, T06]
parallel_with: []
write_scope:
  - stereotype-packages/
  - front-end/src/
  - converted/src/package_runtime/
  - converted/src/model_package/
  - converted/src/tests/
  - examples/vae_mnist/
  - docs/knowledge/
---

# Stereotype-declared wheel adapters

## Objective

Document and complete the implemented v1 contract for stereotype-declared
adapters callable from an installed wheel. The wheel remains generic and does
not add a VAE-specific runtime method.

The adapter is an intentional part of the stereotype's public contract: it is
declared in package metadata, compiled against the concrete stereotype
instance, recorded in the immutable wheel manifest, and invoked through a
generic documented wheel API. The accepted contract is recorded in the
[wheel-adapter decision](../../../../knowledge/decisions/wheel-adapters.md).

Browser submission/download QA is still pending. This task remains
`in_progress` until that real interface check is recorded; the focused Python
tests already cover the implemented runtime path.

## Evidence and starting point

- `wheelAdapters` declarations are parsed in the frontend definition schema and
  selected by names stored on graph nodes.
- The compiler resolves the declaration and binds `module.forward` to the
  existing compiled node module; it does not load an arbitrary Python symbol.
- The exporter records selected descriptors in wheel architecture metadata; the
  runtime checks that metadata against the compiled graph after strict shared-
  state restoration.
- Existing subflows remain composition internals. The current compiler rejects
  adapter selections in nested compilation scopes.

## Implemented v1 contract

Each stereotype package may publish zero or more `wheelAdapters` declarations in
`stereotype.json`. Each v1 declaration has:

- a stable name;
- exactly `entrypoint: "module.forward"`;
- tensor input and output schemas with shape and dtype;
- exactly `targetPolicy: "forbidden"`.

When a diagram explicitly selects an adapter name on a root-graph node, the
compiler resolves the package declaration and binds the adapter to that node's
existing module. The public call is:

```python
model.adapter("decode").run(value)
```

The runtime converts accepted values to a tensor, checks the declared input
schema, calls only the bound module's `forward`, then checks the declared output
schema. The adapter receives no target and cannot execute objective nodes.

The selected descriptors are copied into the wheel's immutable architecture
metadata. `load_model()` compiles the embedded graph, restores the shared state
strictly, verifies descriptor equality, and returns the generic adapter facade.

## Implemented boundaries

- No adapter is discovered from a Python symbol, package/class ID or display
  name.
- Duplicate public names, missing declarations, non-module targets, objective
  bindings and malformed tensor schemas fail validation.
- The adapter uses the same module store and safetensors state as prediction;
  it does not rebuild or duplicate parameters.
- A wheel with no selected adapters preserves the prediction-only API.
- Nested-scope adapter selection is currently rejected; subflow internals are
  not a public v1 binding target.
- The metadata validator recognizes optional randomness fields, but seeded
  sampling behavior has not been established by the current tests or browser
  QA.

## Invariants

- A wheel with no selected adapters preserves the prediction-only v1 API and
  behavior exactly.
- An adapter is callable only when both its stereotype declaration and a
  concrete diagram binding are present in the authenticated immutable bundle.
- Adapters share the compiled module store and safetensors state; they neither
  duplicate nor recreate parameters.
- The objective region and `batch.targets` are worker-only. A wheel adapter
  cannot receive or reach either, implicitly or explicitly.
- No adapter is inferred from a node/subflow UI name, a Python symbol, or the
  class/package ID alone.
- Package code receives only the declared input values and its narrow bound
  capability. It does not gain compiler, graph, catalog, filesystem, process
  or worker-control authority through the adapter mechanism.
- A clean installed wheel remains independent of the repository and training
  dataset.

## Verification status

Focused runtime and wheel tests pass: `29 passed` from
`converted/src/tests/test_package_runtime.py` and
`converted/src/tests/test_model_package.py`. Browser submission/download and
clean-environment QA for a selected adapter remains pending.

## Acceptance criteria

- [x] Adapter selection, fixed `module.forward` binding, tensor schemas and
      target-forbidden validation are implemented.
- [x] The generic `load_model().adapter(name).run(value)` facade is implemented
      without a public model-internals handle.
- [x] Selected adapter metadata is recorded in the wheel and checked against
      the compiled graph after strict state restoration.
- [x] Focused runtime and clean-wheel tests cover shared module execution,
      schema checks, unknown names and target-free inference.
- [ ] Browser submission, download and clean-environment execution of a
      selected adapter is verified through the real UI.
- [ ] A VAE example exercises a real public adapter through the installed wheel
      and receives visual QA.

## Required handoff

Return the accepted declaration and binding syntax, focused test results, and
the browser/clean-environment evidence when T06 QA is complete.
