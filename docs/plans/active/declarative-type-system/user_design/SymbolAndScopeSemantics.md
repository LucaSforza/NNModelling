# Symbol and Scope Semantics

> **Status:** Draft design specification  
> **Scope:** Symbol declaration, binding, unification, lifetime, and scope semantics for symbolic dimensions in NNModelling.

## 1. Purpose

Symbolic dimensions allow a `TypeSignature` to express relationships between tensor dimensions without requiring all dimensions to be concrete integers.

Examples:

```text
[$B, param.in_features]
[$B, param.out_features]
```

Here `$B` represents a symbolic dimension shared between different parts of the same type-signature evaluation.

Symbols are declared explicitly by the `TypeSignature`, and each symbol has a scope:

```text
LOCAL
GLOBAL
```

Normal expressions may read symbols, but only `ShapePattern` matching may create new bindings.

## 2. Symbol declarations

Every symbol referenced by a `TypeSignature` must be declared explicitly.

Conceptually:

```yaml
symbols:
  B: local
  N: global
```

The concrete serialization format may differ, but the semantic information is:

```text
SymbolDeclaration {
    name
    scope: LOCAL | GLOBAL
}
```

A symbol reference uses:

```text
$<name>
```

Examples:

```text
$B
$N
```

The symbol scope is determined by its declaration, not by the reference syntax.

## 3. Compile-time validation

The following conditions are compile-time errors:

### 3.1 Undeclared symbols

A symbol may not be referenced unless it is declared by the `TypeSignature`.

Invalid:

```text
[$B, 128]
```

when `B` is not declared.

Result:

```text
CompileError(UndeclaredSymbol("B"))
```

### 3.2 Conflicting declarations

The same symbol name may not be declared more than once with incompatible scopes.

Invalid:

```yaml
symbols:
  - name: B
    scope: local
  - name: B
    scope: global
```

Result:

```text
CompileError(ConflictingSymbolDeclaration("B"))
```

### 3.3 Scope is resolved during compilation

After `TypeSignature` compilation, each symbol reference is resolved to a declared symbol and its scope.

Runtime evaluation must not infer scope from the symbol name.

## 4. Symbol creation and binding

A symbolic binding is created only by `ShapePattern` matching.

For example:

```text
[$B, param.in_features]
```

matched against:

```text
[32, 128]
```

produces:

```text
$B = 32
```

if `param.in_features == 128`.

A normal expression such as:

```text
$B
```

may only read the existing binding.

It may not create or mutate it.

## 5. Reading an unbound symbol

A symbol may be declared but not yet bound.

Reading such a symbol produces:

```text
Deferred(UnboundSymbol("B"))
```

This is not an error, because a later matching step or inference pass may provide the missing information.

## 6. LOCAL scope

A `LOCAL` symbol belongs to one specific application of a `TypeSignature`.

Conceptually, its runtime identity is:

```text
(TypeSignatureApplicationId, SymbolName)
```

Therefore two different applications of the same `TypeSignature` do not share local bindings.

Example:

```text
Node A applies Linear signature:
    $B LOCAL = 32

Node B applies Linear signature:
    $B LOCAL = 64
```

This is valid.

The two `$B` symbols are distinct even though they have the same declaration name.

A new local symbol environment is created for every `TypeSignature` application.

## 7. GLOBAL scope

A `GLOBAL` symbol belongs to the current root graph inference session.

Conceptually, its runtime identity is:

```text
(InferenceSessionId, SymbolName)
```

All `TypeSignature` applications in the same inference session that declare the same global symbol name refer to the same logical symbol.

Example:

```text
Signature A:
    N: GLOBAL

Signature B:
    N: GLOBAL
```

Within one graph inference session:

```text
A.$N == B.$N
```

Both declarations participate in the same binding.

A new inference session creates a new global symbol environment.

Global bindings do not persist across unrelated inference sessions.

## 8. Symbol binding rules

### 8.1 Binding an unbound symbol

If a pattern encounters a dimension while its corresponding symbol is unbound:

```text
$B := encountered_dimension
```

The binding is added to the symbol environment.

### 8.2 Binding an already-bound symbol

If the symbol is already bound, the encountered dimension must unify with the existing binding.

Example:

```text
$B = 32
```

then a later match encounters:

```text
32
```

The match succeeds.

If it encounters:

```text
64
```

the result is:

```text
Error(SymbolConflict("B", 32, 64))
```

The existing binding is not replaced.

## 9. Symbol-to-symbol binding

A symbol may be bound to another symbolic dimension.

Example:

```text
input dimension = $X
pattern          = $B
```

may produce a relationship equivalent to:

```text
$B == $X
```

rather than requiring either symbol to have an immediately known integer value.

The symbol system must therefore support symbolic equivalence, not only:

```text
Symbol -> Int
```

Conceptually, bindings form equivalence relationships that may later become concrete.

Example:

```text
$B == $X
$X == 32
```

implies:

```text
$B == 32
```

The concrete implementation may use union-find, canonical representatives, or another equivalent mechanism. The implementation strategy is not part of this specification.

## 10. Unification semantics

Unification attempts to make two dimension values consistent.

At minimum, it must support:

```text
Concrete <-> Concrete
Symbol   <-> Concrete
Symbol   <-> Symbol
```

### Concrete with concrete

```text
32 unify 32 -> success
32 unify 64 -> Error(DimensionConflict(...))
```

### Symbol with concrete

```text
unbound $B unify 32 -> bind $B = 32
bound $B=32 unify 32 -> success
bound $B=32 unify 64 -> Error(SymbolConflict(...))
```

### Symbol with symbol

```text
unbound $B unify unbound $X
-> establish $B == $X
```

If one later becomes concrete, the value propagates through the equivalence relation.

If both are already concretely bound to incompatible values:

```text
$B = 32
$X = 64

$B unify $X
-> Error(SymbolConflict(...))
```

## 11. Symbol conflicts

A symbol conflict is a runtime `Error`, not a `Deferred` result.

Example:

```text
first match:
    $B = 32

second match:
    requires $B = 64
```

Result:

```text
Error(SymbolConflict("B", 32, 64))
```

The system knows that the constraints are incompatible; no future information can resolve the conflict.

## 12. Interaction with expression evaluation

Normal expressions read the current symbol environment.

For:

```text
$B
```

the evaluation rules are:

```text
bound to concrete dimension -> Value(Dimension)
bound symbolically          -> Value(symbolic Dimension)
declared but unbound        -> Deferred(UnboundSymbol("B"))
undeclared                  -> impossible after successful TypeSignature compilation
```

A compile-time validated evaluator must never discover an undeclared symbol at runtime.

## 13. Interaction with ShapePattern

`ShapePattern` is the only language construct allowed to create symbol bindings.

For example:

```text
[$B, param.in_features]
```

performs two different operations:

```text
$B
    -> bind/unify with the encountered dimension

param.in_features
    -> evaluate the parameter and check compatibility
```

Outside a `ShapePattern`, `$B` never has binding semantics.

## 14. Lifetime

### LOCAL

Lifetime:

```text
one TypeSignature application
```

The environment is discarded when that application is no longer part of the inference evaluation.

### GLOBAL

Lifetime:

```text
one root graph inference session
```

The environment is shared by all participating TypeSignature applications during that session and discarded when the session ends.

## 15. Namespace semantics

Symbol names are the namespace keys within their corresponding scope.

Therefore, within the same inference session:

```text
GLOBAL "B"
```

declared by different signatures refers to the same symbol.

This behaviour is intentional.

Users and stereotype authors must therefore choose global symbol names deliberately.

Local symbols with the same name remain isolated because their namespace also contains the `TypeSignatureApplicationId`.

## 16. Examples

### Local batch symbol

Signature:

```yaml
symbols:
  B: local
```

Pattern:

```text
[$B, param.in_features]
```

Two nodes may infer:

```text
Node A: $B = 32
Node B: $B = 64
```

without conflict.

### Shared global symbol

Signature A:

```yaml
symbols:
  N: global
```

Signature B:

```yaml
symbols:
  N: global
```

If A binds:

```text
$N = 128
```

then B observes the same binding.

If B later requires:

```text
$N = 256
```

evaluation returns:

```text
Error(SymbolConflict("N", 128, 256))
```

### Symbolic-to-symbolic unification

Given:

```text
input dimension = $X
pattern          = $B
```

matching establishes:

```text
$B == $X
```

If later:

```text
$X = 32
```

then `$B` resolves to the same dimension.

## 17. Design invariants

1. Every symbol used by a `TypeSignature` is declared explicitly.
2. Every declaration has exactly one scope: `LOCAL` or `GLOBAL`.
3. Symbol scope is resolved during `TypeSignature` compilation.
4. Normal expressions may read symbols but may not bind them.
5. Only `ShapePattern` matching creates new symbol bindings.
6. `LOCAL` symbols are isolated per `TypeSignature` application.
7. `GLOBAL` symbols are shared by name across one root graph inference session.
8. Two global declarations with the same name refer to the same logical symbol.
9. A declared but unbound symbol evaluates to `Deferred`.
10. An incompatible repeated binding produces `Error`.
11. Symbols may unify with concrete dimensions or with other symbolic dimensions.
12. Symbol environments do not persist beyond their defined lifetime.

## 18. Out of scope

This document does not define:

- the concrete data structure used to implement symbol equivalence;
- the complete `ShapePattern` matching algorithm;
- graph traversal or inference-session scheduling;
- persistence of symbolic information in project files;
- UI representation of symbolic bindings;
- the complete TypeSignature evaluation order.

These are defined in separate design documents.
