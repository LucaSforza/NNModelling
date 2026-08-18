# Expression Language Type System

> **Status:** Draft design specification  
> **Scope:** Static typing rules for the unified NNModelling expression language.  
> Runtime evaluation semantics, symbol scopes, TypeSignature execution semantics, and compile-time architecture are specified separately.

## 1. Purpose

The NNModelling expression language is statically typed.

Every expression must have a statically known result type before a `TypeSignature` can be compiled and loaded.

The type checker must reject:

- invalid operators;
- invalid function calls;
- invalid lambda result types;
- invalid indexing;
- invalid spreads;
- invalid references;
- expressions whose result type does not match the expected type of their use site.

No statically detectable type error may reach runtime evaluation.

## 2. Core types

The expression language defines the following core types:

```text
Int
Dimension
Bool
String
DType
Shape
TensorType
List<T>
```

These types are distinct.

In particular:

```text
Int != Dimension
Shape != List<Dimension>
```

even when values of these types may sometimes have compatible concrete representations.

## 3. Literal types

### Integer literals

```text
42
0
128
```

have type:

```text
Int
```

### Boolean literals

```text
true
false
```

have type:

```text
Bool
```

### String literals

```text
"foo"
"batch"
```

have type:

```text
String
```

### DType literals

DType literals have type:

```text
DType
```

The concrete lexical syntax for dtype literals is defined by the grammar/parser specification.

## 4. Reference types

### Stereotype parameters

For:

```text
param.foo
```

the static type is taken from the declaration of stereotype parameter `foo`.

Examples:

```text
param.axis          : Int
param.out_features  : Int
param.dtype         : DType
param.output_shape  : Shape
```

A reference to an undeclared parameter is a compile-time error.

### Input groups

For a named input group:

```text
inputs.main
```

the static type is:

```text
List<TensorType>
```

Therefore:

```text
inputs.main[0]
```

has type:

```text
TensorType
```

A reference to an undeclared input group is a compile-time error.

### Symbols

For:

```text
$B
```

the static type is:

```text
Dimension
```

A symbol must be declared by the enclosing `TypeSignature`.

An undeclared symbol is a compile-time error.

Whether the symbol is currently bound is a runtime concern and is handled by the Evaluation Semantics specification.

## 5. Contextual expected types

Expressions are compiled with an expected result type determined by their use site.

Examples:

```text
TypeConstraint.condition -> Bool
ComputedDimension.expr   -> Dimension
ComputedShape.expr       -> Shape
Output dtype expression  -> DType
```

An expression may be syntactically valid and internally well typed but still be rejected because its result type does not match the expected type.

Example:

```text
rank(inputs.main[0])
```

has type:

```text
Int
```

and cannot be used directly where `Bool` is required.

## 6. Implicit conversion: Int to Dimension

The language supports one important contextual implicit conversion:

```text
Int -> Dimension
```

but only when the surrounding context requires a `Dimension`.

Example:

```text
[$B, 128]
```

is valid as a `Shape` because `128 : Int` is contextually accepted as a `Dimension`.

The conversion is not symmetric.

There is no general implicit conversion:

```text
Dimension -> Int
```

A symbolic or otherwise non-concrete dimension must not silently become an integer.

## 7. Shape and List<Dimension>

`Shape` and `List<Dimension>` are distinct types.

A `Shape` represents tensor shape semantics.

A `List<Dimension>` is an ordinary generic collection of dimensions.

They are not implicitly interchangeable.

However, both may participate in spread operations when the surrounding sequence expects dimensions.

Examples:

```text
[$B, ...param.output_shape]
```

when:

```text
param.output_shape : Shape
```

is valid.

Likewise:

```text
[$B, ...some_dimension_list]
```

is valid when:

```text
some_dimension_list : List<Dimension>
```

## 8. Sequence literals

A sequence literal:

```text
[e1, e2, ...]
```

is contextually typed.

If the expected type is:

```text
Shape
```

then each element must be compatible with `Dimension`.

Example:

```text
[$B, param.out_features]
```

may have type:

```text
Shape
```

provided:

```text
$B                 : Dimension
param.out_features : Int
```

and the contextual `Int -> Dimension` conversion is applied.

In a generic list context, the element types must unify to a compatible `T` and the result is:

```text
List<T>
```

The exact inference rules for heterogeneous sequence literals should remain conservative: incompatible element types are a compile-time error.

## 9. Spread typing

A spread expression:

```text
...expr
```

inside a dimension sequence is valid only when `expr` has one of:

```text
Shape
List<Dimension>
```

For example:

```text
[$B, ...param.output_shape]
```

is valid if:

```text
param.output_shape : Shape
```

The spread contributes zero or more `Dimension` values to the surrounding sequence.

Invalid examples include:

```text
...param.axis
```

when:

```text
param.axis : Int
```

and:

```text
..."hello"
```

because neither expression is a dimension sequence.

## 10. Indexing

Indexing uses an `Int` index.

### Generic lists

```text
List<T>[Int] -> T
```

Example:

```text
inputs.main[0] : TensorType
```

### Shapes

```text
Shape[Int] -> Dimension
```

Example:

```text
shape(inputs.main[0])[1] : Dimension
```

Index-out-of-range behaviour is a runtime `Error`, not a static type error.

An index expression whose type is not `Int` is a compile-time error.

## 11. Boolean operators

Logical operators require boolean operands.

```text
Bool && Bool -> Bool
Bool || Bool -> Bool
!Bool        -> Bool
```

Invalid:

```text
1 && 2
```

```text
!param.axis
```

when `param.axis : Int`.

Short-circuit runtime semantics are defined separately.

## 12. Equality

Equality and inequality require compatible operand types.

Conceptually:

```text
T == T -> Bool
T != T -> Bool
```

for supported comparable types.

The type checker may also allow comparisons involving the contextual relation between `Int` and `Dimension` where semantically sound.

Examples:

```text
param.axis == 0
$B == dim(inputs.main[0], 0)
dtype(inputs.main[0]) == param.dtype
```

The result type is always:

```text
Bool
```

When dimensions are symbolic and cannot yet be concretely compared, runtime evaluation may return `Deferred`.

## 13. Ordered comparisons

Ordered comparisons are defined for numeric-like values.

At minimum:

```text
Int <  Int -> Bool
Int <= Int -> Bool
Int >  Int -> Bool
Int >= Int -> Bool
```

and corresponding comparisons involving `Dimension` are allowed when the operands are statically dimension-compatible.

Examples:

```text
param.axis >= 0
$B > 1
dim(inputs.main[0], 1) >= param.min_features
```

The expression still has type:

```text
Bool
```

If a required symbolic dimension cannot yet be evaluated sufficiently at runtime, evaluation may return `Deferred`.

## 14. Arithmetic on Int

Ordinary integer arithmetic is supported:

```text
Int + Int -> Int
Int - Int -> Int
Int * Int -> Int
Int / Int -> Int
Int % Int -> Int
-Int      -> Int
```

Runtime errors such as division by zero are handled by the Evaluation Semantics specification.

## 15. Arithmetic on Dimension

Dimension arithmetic is supported because output dimensions often depend on input dimensions and stereotype parameters.

### Addition

```text
Dimension + Dimension -> Dimension
Dimension + Int       -> Dimension
Int + Dimension       -> Dimension
```

### Subtraction

```text
Dimension - Dimension -> Dimension
Dimension - Int       -> Dimension
Int - Dimension       -> Dimension
```

### Multiplication

```text
Dimension * Dimension -> Dimension
Dimension * Int       -> Dimension
Int * Dimension       -> Dimension
```

### Division by Int

```text
Dimension / Int -> Dimension
```

### Division by Dimension

```text
Dimension / Dimension -> Dimension
```

is statically valid.

However, runtime evaluation may perform the division only when both dimensions can be evaluated as concrete integer dimensions.

If either operand is not yet concretely evaluable, the result is:

```text
Deferred(...)
```

If both are concrete but the operation is invalid, for example division by zero, the result is:

```text
Error(...)
```

The result remains a `Dimension` rather than being converted to `Int`.

This rule preserves tensor-dimension semantics even when the concrete calculation happens to involve integer values.

## 16. Function signatures

The initial standard library contains the following functions.

### shape

```text
shape(TensorType) -> Shape
```

Example:

```text
shape(inputs.main[0])
```

### dim

```text
dim(TensorType, Int) -> Dimension
```

Example:

```text
dim(inputs.main[0], 1)
```

### dtype

```text
dtype(TensorType) -> DType
```

### rank

```text
rank(TensorType) -> Int
rank(Shape)      -> Int
```

### len

```text
len(List<T>) -> Int
len(Shape)   -> Int
```

### first

```text
first(List<T>) -> T
first(Shape)   -> Dimension
```

### last

```text
last(List<T>) -> T
last(Shape)   -> Dimension
```

Runtime behaviour for empty collections is an `Error`.

## 17. Higher-order functions

Higher-order functions are statically typed.

### map

```text
map<A, B>(List<A>, A -> B) -> List<B>
```

Example:

```text
map(inputs.operands, x => dim(x, 1))
```

has type:

```text
List<Dimension>
```

because:

```text
inputs.operands : List<TensorType>
x               : TensorType
dim(x, 1)       : Dimension
```

### all

```text
all<T>(List<T>, T -> Bool) -> Bool
```

Valid:

```text
all(inputs.operands, x => rank(x) == 4)
```

Invalid:

```text
all(inputs.operands, x => rank(x))
```

because the lambda returns `Int`, not `Bool`.

### any

```text
any<T>(List<T>, T -> Bool) -> Bool
```

The lambda must return `Bool`.

## 18. sum

The initial standard library supports summation over numeric collections.

At minimum:

```text
sum(List<Int>)       -> Int
sum(List<Dimension>) -> Dimension
```

Example:

```text
sum(map(inputs.operands, x => dim(x, 1)))
```

has type:

```text
Dimension
```

## 19. coalesce

`coalesce` combines expressions of compatible result type.

Conceptually:

```text
coalesce<T>(T, T) -> T
```

The two alternatives must have compatible static types.

Examples:

```text
coalesce(param.axis, 0) : Int
```

and, in a `Dimension` context:

```text
coalesce($B, 1) : Dimension
```

Runtime semantics are special:

```text
Value    -> keep first value
Deferred -> evaluate fallback
Error    -> propagate Error
```

`coalesce` never catches a runtime `Error`.

## 20. Lambda typing

Lambda parameters are typed from the expected function signature of the enclosing higher-order function.

Example:

```text
map(inputs.main, x => shape(x))
```

Given:

```text
inputs.main : List<TensorType>
```

the type checker infers:

```text
x : TensorType
```

and:

```text
shape(x) : Shape
```

therefore:

```text
map(...) : List<Shape>
```

Lambda parameters do not default to `Any`.

A lambda whose result type does not match the expected higher-order function signature is a compile-time error.

## 21. No Any escape hatch

The static type system must not use a general `Any` type to bypass type checking.

In particular, higher-order operations must preserve generic type information.

The following must fail during `TypeSignature` compilation:

```text
all(inputs.main, x => rank(x))
```

```text
sum(map(inputs.main, x => shape(x)))
```

```text
shape("hello")
```

A compiled expression must therefore carry enough type information to prevent runtime discovery of such mistakes.

## 22. Valid examples

### Constraint

```text
param.axis >= 0 && param.axis < rank(inputs.main[0])
```

Type:

```text
Bool
```

### Output shape

```text
[$B, param.out_features]
```

Expected type:

```text
Shape
```

### Spread from parameter

```text
[$B, ...param.output_shape]
```

with:

```text
param.output_shape : Shape
```

Expected type:

```text
Shape
```

### Variadic dimension collection

```text
map(inputs.operands, x => dim(x, 1))
```

Type:

```text
List<Dimension>
```

### Summed dimension

```text
sum(map(inputs.operands, x => dim(x, 1)))
```

Type:

```text
Dimension
```

### Symbolic comparison

```text
$B == dim(inputs.main[0], 0)
```

Type:

```text
Bool
```

## 23. Invalid examples

### Wrong boolean operand

```text
1 && true
```

Compile-time error.

### Wrong lambda result

```text
all(inputs.main, x => rank(x))
```

Compile-time error.

### Wrong function argument

```text
shape("hello")
```

Compile-time error.

### Wrong indexing type

```text
inputs.main["first"]
```

Compile-time error.

### Invalid spread

```text
[$B, ...param.axis]
```

when:

```text
param.axis : Int
```

Compile-time error.

### Wrong contextual result

```text
rank(inputs.main[0])
```

used as a `TypeConstraint.condition`.

Compile-time error because:

```text
Int != Bool
```

## 24. Compile-time invariants

1. Every expression has a statically known result type.
2. Every reference is resolved during `TypeSignature` compilation.
3. Lambda parameters and results are statically typed.
4. No general `Any` escape hatch may suppress type errors.
5. `Int` and `Dimension` remain distinct.
6. `Int -> Dimension` is contextual and one-way.
7. `Shape` and `List<Dimension>` remain distinct.
8. Spread is permitted only from dimension-sequence-compatible values.
9. Indexing requires an `Int` index.
10. Higher-order functions preserve their generic input/output types.
11. Every use site enforces an expected result type.
12. Every statically detectable misuse fails during `TypeSignature` compilation.
13. Runtime evaluation never repairs or reinterprets a statically invalid expression.

## 25. Runtime-dependent validity

Some expressions are statically valid but may not yet be concretely evaluable.

Example:

```text
$B / $N
```

has static type:

```text
Dimension
```

but if either symbol is not concretely evaluable at runtime:

```text
Deferred(...)
```

This is not a type error.

Likewise:

```text
$B == $N
```

has static type:

```text
Bool
```

even if the comparison cannot yet be resolved concretely.

The distinction is:

```text
static typing asks:
    "Is this operation meaningful for these types?"

runtime evaluation asks:
    "Do we currently know enough to compute its value?"
```

## 26. Out of scope

This document does not define:

- the complete future standard library;
- user-defined functions;
- function overloading implementation details;
- numeric overflow semantics;
- exact integer-division rounding semantics;
- broadcasting semantics;
- dtype promotion rules;
- symbolic algebra simplification;
- the concrete internal representation of generic types;
- diagnostics formatting.

These may be added when required by concrete TypeSignature use cases.
