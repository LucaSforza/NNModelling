# TypeSignature Semantics

> **Status:** Draft design specification  
> **Scope:** Semantic behaviour of `TypeSignature` evaluation in NNModelling.  
> This document assumes the expression-language grammar, evaluation semantics, and symbol/scope semantics are defined separately.

## 1. Purpose

A `TypeSignature` describes, declaratively, how a stereotype accepts input tensors, constrains them, and computes one output tensor type.

Its semantics must not depend on the stereotype name. Operations such as `Concat`, `Addition`, `Linear`, or `HorizontalRepeat` must emerge from generic `TypeSignature` data and expressions rather than from runtime dispatch on hardcoded stereotype names.

A `TypeSignature` defines:

- an ordered sequence of named `InputGroup`s;
- cardinality rules for each input group;
- an optional shape pattern for each input group;
- a dtype requirement/expression for each input group;
- zero or more constraints;
- one output shape expression;
- one output dtype expression;
- zero or more declared symbolic dimensions.

A successful evaluation produces exactly one logical output `TensorType`:

```text
TensorType {
    shape: Shape
    dtype: DType
}
```

## 2. Conceptual model

Conceptually:

```text
TypeSignature {
    symbols: SymbolDeclaration[*]
    inputs: InputGroup[1..*]
    constraints: TypeConstraint[*]
    outputShape: Expression<Shape>
    outputDType: Expression<DType>
}
```

and:

```text
InputGroup {
    name: String
    min: Int
    max: Int | unbounded
    pattern: ShapePattern | null
    dtype: Expression<DType> | DTypeRequirement
}
```

The concrete serialization format may differ from this conceptual model.

## 3. Named and ordered input groups

Input groups are:

1. **named**, so expressions can refer to them using:

```text
inputs.<groupName>
```

2. **ordered**, so physical incoming edges can be deterministically partitioned into groups.

For example:

```text
inputs.left
inputs.right
inputs.operands
```

Each group receives a contiguous ordered slice of the node's incoming tensors.

## 4. Cardinality

Every `InputGroup` declares a minimum and maximum number of inputs.

Examples:

```text
min = 1, max = 1
min = 2, max = unbounded
min = 0, max = 1
```

### 4.1 Under minimum cardinality

If a group currently contains fewer inputs than its declared minimum:

```text
actual < min
```

evaluation produces:

```text
Deferred(MissingInputs(
    group = <name>,
    expectedMin = <min>,
    actual = <actual>
))
```

This is not a type error because the graph may still be incomplete while the user is editing it.

The UI should surface this condition as a warning or incomplete-state diagnostic rather than as a hard error.

### 4.2 Over maximum cardinality

If a group receives more inputs than allowed:

```text
actual > max
```

evaluation produces an `Error`.

Conceptually:

```text
Error(TooManyInputs(
    group = <name>,
    expectedMax = <max>,
    actual = <actual>
))
```

This is a known-invalid graph state and cannot be resolved merely by waiting for more information.

## 5. Deterministic input-group assignment

To avoid ambiguous partitioning of incoming tensors, a `TypeSignature` may contain **at most one variadic `InputGroup`**.

A variadic group is a group whose maximum cardinality is unbounded, or otherwise whose cardinality admits a variable number of inputs.

All other groups must have a fixed cardinality for the purposes of deterministic assignment.

Examples of valid layouts:

```text
[1] [1]
[2..*]
[1] [2..*]
[2..*] [1]
```

Layouts that would require ambiguous partitioning are rejected during `TypeSignature` compilation.

The compiler must ensure that the declared input-group structure admits a deterministic assignment strategy.

## 6. Shape-pattern semantics

Each `InputGroup` has:

```text
pattern: ShapePattern | null
```

### 6.1 Non-null pattern

If `pattern` is present, every tensor assigned to the group is matched against that `ShapePattern`.

Pattern matching may:

- check fixed dimensions;
- check parameter-derived dimensions;
- bind declared symbolic dimensions;
- unify already-bound symbolic dimensions;
- produce `Deferred` when required information is unavailable;
- produce `Error` when dimensions are incompatible.

Symbol binding follows the separate **Symbol and Scope Semantics** specification.

### 6.2 Null pattern

If:

```text
pattern == null
```

the group accepts **any input shape**.

A null pattern:

- performs no shape restriction;
- creates no symbol bindings;
- does not modify the expression-language grammar;
- does not disable the group's cardinality checks;
- does not disable dtype checking;
- does not disable later `TypeConstraint`s.

`null` is therefore a `TypeSignature`-level semantic value, not expression-language syntax.

## 7. DType semantics

DType requirements are associated with individual `InputGroup`s rather than with the `TypeSignature` as a whole.

This allows different groups to require different dtypes.

For example, a future stereotype may conceptually accept:

```text
inputs.data  -> Float32
inputs.mask  -> Bool
```

Each group's dtype requirement/expression is statically checked during `TypeSignature` compilation.

At runtime, actual input dtypes are checked against the evaluated requirement.

The exact compatibility relation between dtypes is defined separately from this document.

A dtype incompatibility produces `Error`.

If the dtype requirement cannot yet be evaluated because required information is missing, evaluation produces `Deferred`.

## 8. Constraints

A `TypeConstraint` contains an expression whose statically required result type is:

```text
Bool
```

Constraint evaluation follows:

```text
Value(true)  -> constraint satisfied
Value(false) -> Error(ConstraintViolation(...))
Deferred(r)  -> Deferred(r)
Error(e)     -> Error(e)
```

A constraint whose expression does not statically type-check as `Bool` must be rejected when compiling the `TypeSignature`; it must never reach runtime evaluation.

Constraints may refer to:

- named input groups;
- input tensor types;
- stereotype parameters;
- previously bound symbols;
- generic expression-language functions.

## 9. Output semantics

A `TypeSignature` produces exactly **one output shape** and exactly **one output dtype**.

These are evaluated from:

```text
outputShape : Expression<Shape>
outputDType : Expression<DType>
```

Together they form the single logical output:

```text
TensorType(outputShape, outputDType)
```

Multi-output `TypeSignature`s are intentionally out of scope for the current design.

The output expressions may read symbols bound during input shape matching.

For example:

```text
input pattern:
    [$B, param.in_features]

output shape:
    [$B, param.out_features]
```

## 10. Evaluation pipeline

A `TypeSignature` is evaluated in the following semantic order:

```text
1. Normalize stereotype parameters
2. Assign incoming tensors to named InputGroups
3. Validate group cardinalities
4. Match input ShapePatterns and bind/unify symbols
5. Evaluate and validate input-group dtype requirements
6. Evaluate TypeConstraints
7. Evaluate output Shape expression
8. Evaluate output DType expression
9. Construct the output TensorType
```

This order is intentional.

In particular:

- symbols must be bound before constraints and output expressions attempt to read them;
- input-group assignment happens before expressions access `inputs.<name>`;
- output computation occurs only after the input requirements and constraints have been considered.

## 11. Interaction with `Value / Deferred / Error`

Each phase may produce:

```text
Value
Deferred
Error
```

according to the separate evaluation-semantics specification.

### 11.1 Error

If a phase produces `Error`, evaluation stops and returns that error.

A known-invalid signature application must not be downgraded to `Deferred`.

### 11.2 Deferred

If information required by the signature is unavailable, evaluation returns `Deferred`.

Examples include:

```text
MissingInputs(...)
MissingParameter(...)
UnknownInputShape(...)
UnboundSymbol(...)
```

A `Deferred` result represents an incomplete but not yet known-invalid model state.

### 11.3 Successful result

Evaluation succeeds only when the required input checks, constraints, and output expressions produce sufficient information to construct:

```text
Value(TensorType(...))
```

## 12. Parameter semantics

Parameters are normalized before the rest of the `TypeSignature` is evaluated.

References such as:

```text
param.axis
param.out_features
```

follow the expression-evaluation rules:

```text
resolved(value) -> Value(value)
unset           -> Deferred(MissingParameter(...))
invalid         -> Error(InvalidParameter(...))
```

An invalid parameter must never be treated as merely absent.

## 13. Compile-time requirements

The following properties must be validated when compiling a `TypeSignature`:

- all input-group names are unique;
- all referenced input groups exist;
- input-group cardinalities are structurally valid;
- input-group assignment is deterministic;
- at most one group is variadic;
- every referenced symbol is declared;
- symbol scopes are valid;
- every expression parses successfully;
- every expression type-checks;
- each constraint expression has result type `Bool`;
- the output shape expression has result type `Shape`;
- the output dtype expression has result type `DType`;
- each input-group dtype expression has the expected dtype-related type;
- function and lambda signatures are statically valid.

A `TypeSignature` that fails any of these checks must not enter runtime evaluation.

## 14. Example: Linear-like signature

Conceptually:

```yaml
symbols:
  B: local

inputs:
  - name: main
    min: 1
    max: 1
    pattern: "[$B, param.in_features]"
    dtype: "dtype(inputs.main[0])"

constraints: []

outputShape: "[$B, param.out_features]"
outputDType: "dtype(inputs.main[0])"
```

Given:

```text
input shape = [32, 128]
param.in_features = 128
param.out_features = 64
```

matching binds:

```text
$B = 32
```

and the result becomes:

```text
TensorType(
    shape = [32, 64],
    dtype = <input dtype>
)
```

## 15. Example: variadic group

Conceptually:

```yaml
inputs:
  - name: operands
    min: 2
    max: unbounded
    pattern: null
```

Expressions can then refer to:

```text
inputs.operands
```

and constraints may inspect the whole group:

```text
all(inputs.operands, x => rank(x) == rank(inputs.operands[0]))
```

If only one operand is connected:

```text
Deferred(MissingInputs(
    group = "operands",
    expectedMin = 2,
    actual = 1
))
```

If the group's maximum were finite and exceeded, the result would be an `Error`.

## 16. Example: unrestricted shape with dtype restriction

A group may intentionally accept any shape:

```yaml
inputs:
  - name: mask
    min: 1
    max: 1
    pattern: null
    dtype: "bool"
```

`pattern: null` means the shape is unconstrained, while the dtype requirement still applies.

## 17. Design invariants

1. A `TypeSignature` is declarative and must not require dispatch on stereotype names.
2. Input groups are ordered and named.
3. Input-group names are the stable identifiers used by expressions.
4. Input assignment must be deterministic.
5. At most one `InputGroup` may be variadic.
6. Fewer than the minimum required inputs produces `Deferred`, not `Error`.
7. More than the maximum allowed inputs produces `Error`.
8. `pattern: null` accepts any shape and performs no symbol binding.
9. `pattern: null` does not disable cardinality, dtype, or constraint checks.
10. DType requirements belong to individual input groups.
11. Constraints must statically return `Bool`.
12. A false constraint produces `Error(ConstraintViolation)`.
13. Symbol binding occurs before constraints and output expressions are evaluated.
14. A `TypeSignature` produces exactly one output `Shape` and one output `DType`.
15. All statically detectable structural and typing errors are rejected during `TypeSignature` compilation.

## 18. Out of scope

This document does not define:

- the exact JSON serialization schema;
- the concrete dtype compatibility lattice;
- multi-output signatures;
- graph traversal order;
- Repeat or HorizontalRepeat expansion semantics;
- the implementation of symbolic unification;
- UI rendering of warnings and errors;
- the compiled AST representation.

Those topics are specified separately.
