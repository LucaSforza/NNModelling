---
kind: knowledge
status: current
updated: 2026-08-12
---

# Tensor type-system contract

The editor performs constraint-based shape and dtype inference before Python
execution. Stereotype JSON declares contracts; `TypeEngine` interprets generic
semantics and must not branch on stereotype names.

## Type model

A `TensorType` is an ordered shape plus an extensible string dtype. Dimension
patterns support:

- `const`: literal integer;
- `symbolic`: named unification variable;
- `param_ref`: node parameter value;
- `wildcard`: zero or more dimensions;
- `computed`: expression-derived value;
- `param_spread`: tuple/list parameter expanded into dimensions.

`$` symbols participate in the propagated environment. `#` symbols are local
to one stereotype inference and do not leak downstream. Keep `$B` for the
shared batch dimension and use local symbols for internal sequence, channel or
feature relationships unless a dimension is intentionally global.

## Declarative behavior

`type_signature.kind` is `module`, `join` or `subflow`.

- Modules match one input pattern and resolve one output pattern.
- Joins match ordered input patterns and select generic actions such as
  element-wise, concat, matmul or einsum.
- Subflows select identity, recursive inference, repeat composition, or
  infer-then-transform.
- Computed dimensions use the expression language under `front-end/src/expr/`.
- Dtype input/output contracts and advisories are declared in stereotype JSON.

Generic semantic primitives remain engine code: for example, JSON selects
concat while the engine validates ranks and non-concatenated dimensions. This
is data-selected behavior, not arbitrary code encoded in JSON.

## Result contract

`TypeResult` contains:

- `ok` and hard `errors`;
- per-node input/output `annotations`;
- non-blocking categorized `warnings`;
- parameter `suggestions` derived from concrete incoming dimensions.

Invalid parameter text is a hard error; a genuinely unset value may yield a
suggestion. Downstream nodes blocked by a primary failure record `blockedBy`
instead of emitting duplicated errors.

## Extension rule

A conventional new layer should require stereotype and test changes only. Add
engine code only for a genuinely new generic dimension, join or subflow
semantic. Cover parser/evaluator changes separately from type-engine behavior.

Principal definitions are in `front-end/src/conversion/tensortypes.ts`; runtime
logic is in `front-end/src/conversion/typeEngine.ts`. Public educational
documentation is in `docs2/source/type_system.rst`.
