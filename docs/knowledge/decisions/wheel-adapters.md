---
kind: knowledge
status: current
updated: 2026-08-27
---

# Declarative wheel adapters

## Decision

Wheel adapters v1 are opt-in capabilities declared by a stereotype definition
and selected explicitly on graph nodes. They extend the generic installed-wheel
facade without exporting arbitrary functions from `pytorch.py` or exposing the
compiled graph.

The declaration is `wheelAdapters` in `stereotype.json`. A v1 declaration has a
stable name, the fixed entrypoint `module.forward`, tensor input and output
schemas, and `targetPolicy: "forbidden"`. The node stores the selected adapter
names. A package with no selected adapters retains the prediction-only wheel
surface.

```json
{
  "wheelAdapters": [
    {
      "name": "decode",
      "entrypoint": "module.forward",
      "input": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"},
      "output": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"},
      "targetPolicy": "forbidden"
    }
  ]
}
```

The public call is deliberately generic:

```python
model = load_model()
result = model.adapter("decode").run(value)
```

The runtime converts accepted values to a tensor, checks the declared input
shape/dtype, invokes the bound module's `forward`, and checks the declared
output shape/dtype. Unknown names fail. Adapters cannot receive targets,
execute the objective region, or select a dataset adapter.

## Binding and state

The frontend validates declarations and serializes selected names into the
content-addressed package bundle. The compiler resolves each name against the
referenced package definition, rejects duplicate public names and invalid
targets, and binds it to the selected compiled node. The adapter wraps that
node's existing module; it does not build another module or copy parameters.

The wheel embeds the selected adapter descriptors in its immutable architecture
metadata. On load, the runtime compiles the embedded graph, restores the one
shared state dict strictly, and rejects metadata that differs from the
compiled selections. The facade exposes only `load_model`, prediction methods,
and the generic `adapter(name).run(value)` handle. Graph modules, module maps,
compiler services, package catalogs and subflow implementation objects are not
part of this contract.

The current implementation accepts adapter selections on the root graph. A
selection in a nested compilation scope is rejected; direct public binding to a
subflow instance is therefore not a v1 capability.

## Boundaries and non-goals

- `module.forward` is the only v1 adapter protocol; a Python symbol is not an
  export API.
- Input and output schemas are tensor schemas with symbolic dimensions bound
  by the input. Other public value types are not part of this v1 contract.
- Targets are forbidden, including implicit `batch.targets`; objective and
  loss execution remains training-only.
- Package IDs, class names, display names and Python introspection cannot
  discover or dispatch adapters.
- The adapter does not expose a raw `torch.nn.Module` or permit access to
  compiler/runtime internals.
- The metadata validator currently recognizes `randomness` declarations, but
  no browser-level seeded sampling behavior is established by this decision.

## Security and compatibility invariants

- Package files remain relative, digest-checked resources and PyTorch source
  remains behind the existing restricted loader.
- Declarations, node selections, names, schemas and target policy are checked
  before adapter use; malformed or unavailable selections fail explicitly.
- An adapter observes the same trained parameters as prediction and cannot
  create a second trainable state.
- Adding no adapter does not change prediction behavior or the existing
  `load_model().predict_tensor()`/`predict()` API.
- Wheel metadata is immutable and versioned. A metadata mismatch is a load
  error, not a fallback to an internal graph node.

## Repository evidence

- Definition types and validation: `front-end/src/type-system/packages/types.ts:15-55`,
  `front-end/src/type-system/packages/validation.ts:28-78`.
- Bundle selection, canonicalization and digest: `front-end/src/training/package-bundle.ts:6-16,50-117,119-175`.
- Compiler selection, validation and shared binding:
  `converted/src/package_runtime/compiler.py:285-410,629-724`.
- Wheel metadata and public facade:
  `converted/src/model_package/exporter.py:45-85`,
  `converted/src/model_package/runtime.py:14-83`.
- Focused behavior coverage:
  `converted/src/tests/test_package_runtime.py:391-535`,
  `converted/src/tests/test_model_package.py:128-168`.

Browser submission/download QA for a selected adapter is still pending; the
focused Python tests do not constitute that end-to-end proof.
