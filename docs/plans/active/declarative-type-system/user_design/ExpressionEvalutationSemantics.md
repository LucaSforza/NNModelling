# Expression Evaluation Semantics

> **Status:** Draft design specification  
> **Scope:** Runtime evaluation semantics for the NNModelling expression language.  
> Static typing, symbol scoping, TypeSignature execution order, and compile-time architecture are specified separately.

## 1. Purpose

Expressions are statically checked when a `TypeSignature` is compiled.

After compilation, evaluating an expression must never produce a type error that could have been detected statically. Runtime evaluation only deals with:

- concrete values;
- temporarily unavailable information;
- runtime-invalid states that depend on actual graph, parameter, or shape data.

Every evaluated expression produces exactly one of:

```text
Value<T>
Deferred(reason)
Error(reason)
```

where `T` is the statically known result type of the expression.

## 2. Evaluation results

### 2.1 `Value<T>`

`Value<T>` means that evaluation completed successfully and produced a concrete result.

Examples:

```text
Value<Int>(3)
Value<Bool>(true)
Value<Dimension>(128)
Value<Shape>([$B, 128])
```

### 2.2 `Deferred`

`Deferred` means that the expression is valid, but its value cannot currently be determined because some required information is not yet available.

`Deferred` is **not an error**.

Examples:

```text
Deferred(MissingParameter("axis"))
Deferred(UnknownInput("main"))
Deferred(UnknownInputShape("main", 0))
Deferred(UnboundSymbol("B"))
```

A deferred result should preserve a cause so that the editor can provide useful diagnostics and reevaluate the expression when the missing information becomes available.

### 2.3 `Error`

`Error` means that evaluation encountered a runtime-invalid state.

Examples include:

```text
Error(InvalidParameter("axis"))
Error(IndexOutOfBounds(...))
Error(ConstraintViolation(...))
Error(IncompatibleRuntimeValue(...))
```

An `Error` is distinct from `Deferred`: an error represents known invalidity, while deferred evaluation represents missing information.

## 3. Parameter semantics

A stereotype parameter is normalized before expression evaluation.

For:

```text
param.<name>
```

the evaluation rules are:

```text
resolved(value) -> Value(value)
unset           -> Deferred(MissingParameter(name))
invalid(reason) -> Error(InvalidParameter(name, reason))
```

An invalid parameter must never be silently converted into `Deferred`.

This distinction is important because expressions such as:

```text
coalesce(param.axis, 0)
```

may recover from an unset parameter but must not hide an invalid parameter.

## 4. Default propagation

For an ordinary strict operation:

```text
f(a, b, ...)
```

the default rules are:

```text
all operands are Value      -> Value(f(...))
at least one operand Error  -> Error
otherwise, if Deferred      -> Deferred
```

Conceptually:

```text
f(Value(a), Value(b)) -> Value(f(a, b))
f(Error(e), ...)      -> Error(e)
f(..., Error(e))      -> Error(e)
f(Deferred(r), ...)   -> Deferred(r)
f(..., Deferred(r))   -> Deferred(r)
```

If multiple deferred causes exist, an implementation may preserve more than one cause for diagnostics.

Special operators may override the default propagation rules when their result can be determined without evaluating all operands.

## 5. Short-circuit boolean operators

`&&` and `||` use short-circuit semantics.

The right-hand expression is evaluated only when needed.

### 5.1 Logical AND

```text
false && <anything> -> Value(false)
true  && rhs        -> result(rhs)
```

Therefore:

```text
false && Deferred -> Value(false)
false && Error    -> Value(false)

true && Deferred  -> Deferred
true && Error     -> Error
```

### 5.2 Logical OR

```text
true  || <anything> -> Value(true)
false || rhs        -> result(rhs)
```

Therefore:

```text
true || Deferred -> Value(true)
true || Error    -> Value(true)

false || Deferred -> Deferred
false || Error    -> Error
```

The unevaluated branch produces neither errors nor deferred causes.

## 6. `coalesce`

`coalesce` is the explicit mechanism for recovering from deferred values.

Conceptually:

```text
coalesce(a, b)
```

evaluates `a` first.

Rules:

```text
coalesce(Value(v), b) -> Value(v)
coalesce(Deferred, b) -> result(b)
coalesce(Error(e), b) -> Error(e)
```

`coalesce` catches only `Deferred`.

It must never recover from `Error`.

Example:

```text
param.axis = unset

coalesce(param.axis, 0)
-> Value(0)
```

but:

```text
param.axis = invalid("abc")

coalesce(param.axis, 0)
-> Error(InvalidParameter("axis", ...))
```

## 7. Higher-order operations

Higher-order operations such as `map`, `all`, and `any` obey their normal semantic behaviour while preserving `Value / Deferred / Error`.

The lambda's input and output types are guaranteed by compile-time type checking.

### 7.1 `map`

For:

```text
map(xs, f)
```

- if `xs` is `Error`, return `Error`;
- if `xs` is `Deferred`, return `Deferred`;
- otherwise evaluate `f` for each element.

If every application returns `Value`, return the resulting list.

If any application returns `Error`, return `Error`.

Otherwise return `Deferred`.

Conceptually:

```text
map([Value(a), Value(b)], f)
    -> Value([f(a), f(b)])
```

subject to the propagation rules above.

### 7.2 `all`

`all` may determine its result before all elements are known.

For a list of boolean-producing evaluations:

```text
any Value(false) -> Value(false)
else any Error    -> Error
else any Deferred -> Deferred
else              -> Value(true)
```

Evaluation may short-circuit as soon as `Value(false)` is encountered.

For example:

```text
all([false, Deferred], identity)
-> Value(false)
```

### 7.3 `any`

Symmetrically:

```text
any Value(true)  -> Value(true)
else any Error   -> Error
else any Deferred -> Deferred
else              -> Value(false)
```

Evaluation may short-circuit as soon as `Value(true)` is encountered.

## 8. Indexing and other runtime-dependent errors

Operations that are statically well typed may still fail because of runtime values.

For example:

```text
inputs.main[5]
```

may be statically valid because `inputs.main` has type `List<TensorType>` and the index has type `Int`, while runtime evaluation may produce:

```text
Error(IndexOutOfBounds(...))
```

Similarly, shape or tensor operations may fail because actual runtime data violates a condition that cannot be established during expression compilation.

Such failures are runtime `Error`s, not static type errors.

## 9. Static errors are forbidden at runtime

Any error that depends only on the expression syntax and statically known types must be rejected when compiling the `TypeSignature`.

Examples that must never reach runtime evaluation:

```text
1 && 2
all(inputs.main, x => rank(x))
shape("hello")
param.axis + true
```

The compiled expression evaluator can assume that:

- every operator receives statically compatible operands;
- every function call matches a valid signature;
- every lambda has the expected input and output types;
- every expression has the expected result type required by its use site.

Runtime evaluation must therefore not perform a second, weaker version of static type checking.

## 10. Deferred causes

A deferred result should retain enough information to explain why evaluation could not complete.

Initial causes should include at least:

```text
MissingParameter(name)
UnknownInput(group)
UnknownInputElement(group, index)
UnknownInputShape(group, index)
UnboundSymbol(name)
```

The exact diagnostic representation is an implementation detail, but the semantic distinction between different causes is part of the design.

Implementations may aggregate several causes when useful.

## 11. Error causes

Runtime errors should similarly retain structured causes.

Initial categories should include at least:

```text
InvalidParameter(name, reason)
IndexOutOfBounds(...)
ConstraintViolation(...)
InvalidRuntimeValue(...)
```

The exact diagnostic payload is implementation-specific.

## 12. Design invariants

1. Every runtime expression evaluation returns `Value`, `Deferred`, or `Error`.
2. `Deferred` means missing information, not invalidity.
3. `Error` means a known-invalid runtime state.
4. `unset` parameters evaluate to `Deferred`.
5. `invalid` parameters evaluate to `Error`.
6. Invalid parameters must never be downgraded to `Deferred`.
7. Ordinary operations propagate `Error` before `Deferred`.
8. Operators with short-circuit semantics may avoid evaluating branches whose values cannot affect the result.
9. `coalesce` recovers from `Deferred` only, never from `Error`.
10. All statically detectable type errors must fail during `TypeSignature` compilation, never during runtime evaluation.

## 13. Out of scope

This document does not yet define:

- static typing rules;
- symbol binding and `LOCAL` / `GLOBAL` scope;
- the order in which `TypeSignature` inputs, constraints, and outputs are evaluated;
- the serialized and compiled AST representations;
- how deferred expressions are scheduled for reevaluation;
- UI presentation of deferred and error diagnostics.

These are specified in separate design documents.
