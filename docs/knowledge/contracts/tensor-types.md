---
kind: knowledge
status: current
updated: 2026-08-16
---

# Tensor type-system contract

The editor performs shape and dtype inference before conversion. Stereotype JSON
is the source of tensor contracts; the generic engine evaluates compiled v2
signatures and must not branch on an ordinary stereotype name, category, Join
or Subflow action.

## V2 signature

Every declared signature has `version: 2`, ordered `inputs`, one `output`, a
required `to_dtype`, and optional `from_dtype` and `constraints`.

An `InputGroup` partitions the ordered incoming tensors. It declares `lower`,
`upper` (`null` means unbounded), an optional diagnostic `label`, and one
pattern used for every tensor in that group. Version 2 permits at most one
variable-width group, which keeps allocation deterministic. The Join editor derives its minimum
and maximum handle count from these bounds; imported out-of-range counts are
reported rather than silently rewritten.

`ShapeDefinition` is one of:

- `pattern`: resolves an ordinary dimension pattern;
- `computed_shape`: evaluates a generic shape expression;
- `einsum`: evaluates an equation read from its declared parameter.

`einsum` is the intentional exception: the dedicated equation evaluator is
selected exclusively by `output.kind === "einsum"`. It is never selected by a
stereotype name or an action field, and ellipsis is unsupported.

## Patterns, scope, and parameters

Pattern dimensions are `const`, `symbolic`, `param_ref`, `wildcard`, `computed`,
and `param_spread`. A symbolic dimension always declares `scope: "global"` or
`scope: "local"`; global bindings propagate through the graph while local
bindings are limited to the current signature evaluation. A symbol name cannot
be declared in both scopes in one signature.

`param_ref` and `param_spread` reference declared stereotype parameters by
name. Parameter values are normalized and validated: malformed values are hard
diagnostics, while compatible unresolved values can produce suggestions. A
spread expands a list-valued parameter into dimensions; input spread matching is
about arity unless a separate constraint declares value equality.

An output-pattern wildcard replays the capture from the first occurrence of the
first input group. Signatures that need another capture source use
`computed_shape` instead.

## Expressions and validation

Serialized expressions are human-readable DSL source strings, never AST JSON.
The loader structurally validates every signature, verifies parameter and symbol
references, then parses and type-checks expression source before the stereotype
can be used. Compiled ASTs are immutable internal implementation details.

The DSL has typed dimension, shape, constraint, and dtype contexts. It supports
`param.name`, `$symbol`, `$*`, arithmetic and comparisons, shape/list helpers,
collection primitives (`map`, `sum`, `all`), and generic subflow primitives
`apply` and `iterate`. It is not JavaScript: no arbitrary property access,
host calls, mutation, I/O, or evaluation of parameter text is allowed.

Constraints are generic boolean expressions with an optional message, category,
and `error`/`warning` severity. `from_dtype` validates incoming dtype as a
warning; `to_dtype` explicitly computes the output dtype.

## Evaluation result

`TypeResult` provides hard errors, categorized warnings, node input/output
annotations, and parameter suggestions. A primary failure blocks downstream
inference using `blockedBy` rather than duplicating its diagnostic. Conversion
is blocked by hard type errors.

## Extension rule

Add a conventional tensor contract by changing its v2 stereotype and tests.
Add engine code only for a new generic language primitive (dimension, shape,
constraint, dtype, or expression operator), with schema/parser/evaluator tests.
Do not add action fields, formula identifiers, category branches, or
stereotype-name branches. The only allowed specialized shape evaluator is
`EinsumShape`, selected solely by the output discriminant.

Principal definitions are in `front-end/src/type-system/model.ts`; schema
compilation is in `front-end/src/type-system/schema.ts`; generic evaluation is
in `front-end/src/type-system/signatureEvaluator.ts`. Public documentation is
in `docs2/source/type_system.rst`.
