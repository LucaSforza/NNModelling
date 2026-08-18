# Expression Language Grammar

> **Status:** Draft design specification  
> **Scope:** Syntax and core syntactic semantics only.  
> Static typing, evaluation semantics, symbol scoping, and `value / deferred / error` propagation are specified separately.

## 1. Purpose

NNModelling uses a single, composable expression language to describe declarative type-system behaviour.

The same language is reused in different contexts. The context determines the expected result type of an expression. For example:

- a type constraint expects a `Bool`;
- a computed dimension expects a `Dimension`;
- a computed shape expects a `Shape`;
- a dtype expression expects a `DType`.

This avoids defining a separate expression language for each use case while still allowing the type checker to reject expressions whose result type is not valid for their context.

The language must be able to:

- refer to stereotype parameters;
- refer to named input groups;
- read symbolic dimensions previously bound by shape matching;
- manipulate shapes, dimensions, dtypes, and tensor types;
- work with lists and higher-order operations such as `map` and `all`;
- construct shapes and expand dimension sequences;
- express boolean constraints without hardcoding individual stereotypes in the runtime.

## 2. Core value types

The language is designed around:

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

`Int` and `Dimension` are intentionally distinct.

An `Int` is an ordinary integer used for values such as an axis or a count.

A `Dimension` represents a tensor dimension and may therefore also carry symbolic information.

## 3. References

### 3.1 Stereotype parameters

A stereotype parameter is referenced with:

```text
param.<name>
```

Examples:

```text
param.out_features
param.axis
param.output_shape
```

Its static type is derived from the declaration of the corresponding stereotype parameter.

The intended evaluation semantics are:

```text
resolved parameter -> value
unset parameter    -> deferred
invalid parameter  -> error
```

### 3.2 Named input groups

Input groups are referenced by name:

```text
inputs.<group-name>
```

For example:

```text
inputs.main
inputs.operands
```

An input-group reference has type:

```text
List<TensorType>
```

Individual elements can be selected with:

```text
inputs.main[0]
```

### 3.3 Symbolic dimensions

Symbolic dimensions use a `$` prefix:

```text
$B
$N
$H
```

Normal expressions may only **read** symbols that have already been bound.

New symbolic bindings are introduced only by shape-pattern matching.

## 4. General expression grammar

```ebnf
expression
    = lambda_expression
    | or_expression
    ;

lambda_expression
    = identifier, "=>", expression
    | "(", identifier, ")", "=>", expression
    ;

or_expression
    = and_expression, { "||", and_expression }
    ;

and_expression
    = equality_expression, { "&&", equality_expression }
    ;

equality_expression
    = comparison_expression,
      { ("==" | "!="), comparison_expression }
    ;

comparison_expression
    = additive_expression,
      { ("<" | "<=" | ">" | ">="), additive_expression }
    ;

additive_expression
    = multiplicative_expression,
      { ("+" | "-"), multiplicative_expression }
    ;

multiplicative_expression
    = unary_expression,
      { ("*" | "/" | "%"), unary_expression }
    ;

unary_expression
    = ("!" | "-"), unary_expression
    | postfix_expression
    ;

postfix_expression
    = primary_expression,
      {
          "[", expression, "]"
        | "(", [ argument_list ], ")"
      }
    ;

argument_list
    = expression, { ",", expression }
    ;

primary_expression
    = integer_literal
    | string_literal
    | boolean_literal
    | dtype_literal
    | parameter_reference
    | symbol_reference
    | input_group_reference
    | identifier
    | sequence_literal
    | "(", expression, ")"
    ;

parameter_reference
    = "param", ".", identifier
    ;

symbol_reference
    = "$", identifier
    ;

input_group_reference
    = "inputs", ".", identifier
    ;

sequence_literal
    = "[", [ sequence_element, { ",", sequence_element } ], "]"
    ;

sequence_element
    = expression
    | "...", expression
    ;

boolean_literal
    = "true" | "false"
    ;

integer_literal
    = digit, { digit }
    ;

string_literal
    = '"', { character }, '"'
    ;

identifier
    = (letter | "_"), { letter | digit | "_" }
    ;
```

`dtype_literal`, `letter`, `digit`, and `character` are lexical productions defined by the concrete parser.

## 5. Function calls

Functions use ordinary call syntax:

```text
function(arg1, arg2, ...)
```

Examples:

```text
shape(inputs.main[0])
dim(inputs.main[0], 1)
dtype(inputs.main[0])
rank(inputs.main[0])
```

Function names are resolved against the expression-language standard library.

Conceptually, signatures may include:

```text
shape(TensorType) -> Shape
dim(TensorType, Int) -> Dimension
dtype(TensorType) -> DType
rank(TensorType) -> Int
```

The complete standard library is defined separately.

## 6. Lambda expressions

The language supports single-argument lambdas:

```text
x => expression
```

For example:

```text
all(inputs.main, x => rank(x) == 4)

map(inputs.main, x => dim(x, 1))
```

Lambda parameter and result types are statically checked.

Therefore:

```text
all(inputs.main, x => rank(x) == 4)
```

is valid, while:

```text
all(inputs.main, x => rank(x))
```

must be rejected because the lambda returns `Int` rather than `Bool`.

## 7. Shape patterns

Shape patterns are not ordinary expressions.

They perform **matching and symbol binding**, while normal expressions only compute values.

```ebnf
shape_pattern
    = "[", [ pattern_element, { ",", pattern_element } ], "]"
    ;

pattern_element
    = "_"
    | integer_literal
    | symbol_reference
    | parameter_reference
    | "...", parameter_reference
    ;
```

### Wildcard

```text
_
```

matches any single dimension without binding it.

### Fixed dimension

```text
128
```

matches only a compatible fixed dimension.

### Symbol binding

Inside a shape pattern:

```text
$B
```

binds the encountered dimension if `$B` is not already bound.

If `$B` is already bound, the encountered dimension must be compatible with its existing binding.

For example:

```text
[$B, param.in_features]
```

matches a rank-2 shape, binds its first dimension to `$B`, and checks the second against `param.in_features`.

Outside a shape pattern, `$B` only reads the existing binding.

### Spread

A parameter may provide multiple dimensions:

```text
[$B, ...param.input_shape]
```

The spread value must have a type compatible with a sequence of dimensions.

## 8. Sequence and shape construction

Ordinary expressions support sequence literals:

```text
[expr1, expr2, ...]
```

and spread:

```text
[expr1, ...expr2]
```

Examples:

```text
[$B, param.out_features]

[$B, ...param.output_shape]
```

The syntax alone does not determine whether the result is a `Shape` or a generic `List<T>`.

That is determined by static typing and by the expected type of the surrounding context.

For example, in a context expecting `Shape`:

```text
[$B, param.out_features]
```

is valid if both elements are compatible with `Dimension`.

## 9. Operator precedence

From highest to lowest precedence:

1. postfix calls and indexing;
2. unary `!` and `-`;
3. `*`, `/`, `%`;
4. `+`, `-`;
5. `<`, `<=`, `>`, `>=`;
6. `==`, `!=`;
7. `&&`;
8. `||`;
9. lambda `=>`.

Parentheses may override precedence.

## 10. Contextual typing

The same expression language is used by different type-system constructs.

Each use site specifies an expected result type:

```text
TypeConstraint.condition  -> Bool
ComputedDimension.expr    -> Dimension
ComputedShape.expr        -> Shape
DType expression          -> DType
```

An expression can therefore be syntactically valid but invalid in a particular context.

For example:

```text
rank(inputs.main[0])
```

has type `Int` and is therefore invalid when directly used as a `TypeConstraint`.

## 11. Examples

Computed shape:

```text
[$B, param.out_features]
```

Constraint:

```text
rank(inputs.main[0]) == 2
```

Constraint over a variadic input group:

```text
all(inputs.operands, x => rank(x) == 4)
```

Reading a dimension:

```text
dim(inputs.main[0], 1)
```

Collecting dimensions:

```text
map(inputs.operands, x => dim(x, 1))
```

Constraint using a stereotype parameter:

```text
param.axis >= 0 && param.axis < rank(inputs.main[0])
```

## 12. Design invariants

1. NNModelling uses one general expression language rather than separate unrelated languages for dimensions, shapes, constraints, and dtypes.
2. The surrounding context determines the expected result type.
3. Stereotype parameters are accessed through `param.<name>`.
4. Input groups are accessed by name through `inputs.<name>`.
5. Normal expressions may read symbolic dimensions but may not create bindings.
6. Symbolic dimensions are bound by shape-pattern matching.
7. Higher-order functions and lambdas are statically typed.
8. `Int` and `Dimension` are distinct types.
9. `unset` and invalid parameters have distinct evaluation semantics.
10. Stereotype-specific behaviour should emerge from generic language primitives whenever possible rather than runtime dispatch on stereotype names.

## 13. Out of scope

This document intentionally does not yet define:

- the complete static typing rules;
- the complete standard-library function set;
- conversions between `Int`, `Dimension`, `Shape`, and `List<Dimension>`;
- local/global symbol scope semantics;
- `value / deferred / error` propagation;
- parameter normalization;
- serialized versus compiled expression representations;
- evaluation order;
- diagnostic formats.

These require separate design specifications before the language is considered stable.

## 14. Next specification

The next document should define the static type system of the expression language: literal/reference types, operator rules, generic higher-order signatures, shape construction, spread typing, contextual expected-type checking, and negative examples that must fail during type-signature compilation.