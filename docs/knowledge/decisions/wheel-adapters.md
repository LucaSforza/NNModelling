---
kind: knowledge
status: current
updated: 2026-08-28
---

# Declarative wheel adapters

## Decision

Wheel adapters v1 are opt-in capabilities declared by a stereotype definition
and selected explicitly on graph nodes. They extend the generic installed-wheel
facade without exporting arbitrary functions from `pytorch.py` or exposing the
compiled graph.

The stereotype template is `wheelAdapters` in `stereotype.json`. A v1 template
has a stable name, the fixed entrypoint `module.forward`, symbolic tensor input
and output schemas, and `targetPolicy: "forbidden"`. The final graph binding is
an object `{name, input, output}`: its tensor schemas are materialized from the
concrete DiagramCore inference and validated against the symbolic template.
Concrete binding shapes retain the dynamic batch symbol `B` only in position
zero; every non-batch dimension is a positive integer. Input and output must
either both preserve `B` in position zero or both use concrete first dimensions.
The editor may hold selected names before bundling, but the serialized package
binding must be an object; raw string selections are rejected by the compiler.
A package with no selected adapters retains the prediction-only wheel surface.

Stereotype template in `stereotype.json`:

```json
{
  "wheelAdapters": [
    {
      "name": "decode",
      "entrypoint": "module.forward",
      "input": {"type": "tensor", "shape": ["B", "N"], "dtype": "float32"},
      "output": {"type": "tensor", "shape": ["B", "M"], "dtype": "float32"},
      "targetPolicy": "forbidden"
    }
  ]
}
```

Materialized graph binding after DiagramCore inference:

```json
{
  "name": "decode",
  "input": {"type": "tensor", "shape": ["B", 4], "dtype": "float32"},
  "output": {"type": "tensor", "shape": ["B", 8], "dtype": "float32"}
}
```

The public call is deliberately generic:

```python
from nnm_example import Model

model = Model()
result = model.adapter("decode").run(value)
```

The runtime converts accepted values to a tensor, checks the declared input
shape/dtype, invokes the bound module's `forward`, and checks the declared
output shape/dtype. Unknown names fail. Adapters cannot receive targets,
execute the objective region, or select a dataset adapter.

## Binding and state

The frontend validates declarations and uses DiagramCore's inferred node input
and output types to materialize each selected name as an explicit `{name,
input, output}` binding in the content-addressed package bundle. The compiler
resolves the binding name against the referenced package definition, validates
the concrete schemas against the stereotype's symbolic template, rejects raw
strings, duplicate public names and invalid targets, and binds it to the
selected compiled node. The adapter wraps that node's existing module; it does
not build another module or copy parameters.

The wheel embeds the selected adapter descriptors in its immutable architecture
metadata. On load, the runtime compiles the embedded graph, restores the one
shared state dict strictly, and rejects metadata that differs from the
compiled selections. The facade exposes only `Model`, the compatibility
`load_model` factory, prediction methods and the generic
`adapter(name).run(value)` handle. Graph modules, module maps, compiler
services, package catalogs and subflow implementation objects are not part of
this contract.

The current implementation accepts adapter selections on the root graph. A
selection in a nested compilation scope is rejected; direct public binding to a
subflow instance is therefore not a v1 capability.

## Boundaries and non-goals

- `module.forward` is the only v1 adapter protocol; a Python symbol is not an
  export API.
- Selected v1 bindings carry tensor input and output schemas with
  DiagramCore-inferred shapes. The only dynamic symbol permitted in a concrete
  binding is `B` at the first dimension; all remaining dimensions are positive
  integers, and input/output agree on whether that leading `B` is present. The
  final wheel descriptor carries no other stereotype template symbols.
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
- Adding no adapter does not change prediction behavior or the public
  `Model().predict_tensor()`/`predict()` API; `load_model()` remains a
  compatibility factory for the same facade.
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
