# Expression Language for Type Signatures

**Status**: Design Phase
**Goal**: Zero hardcoded logic in TypeEngine. All module-specific behavior declared in JSON via a mini expression language.

---

## 1. What Gets Removed From typeEngine.ts

| Hardcoded Item | Lines | Replaced By |
|---------------|-------|-------------|
| `resolveFormula()` — 4 formula bodies | ~880-900 | Expression evaluator |
| `resolveComputedArg()` — arg resolution | ~570-610 | Variable resolver in evaluator context |
| `resolveConcatDim()` — concat dim resolution | ~505-525 | Expression in join signature |
| `resolveConcatOutput()` — concat output shape | ~530-560 | Expression in join signature |
| Repeat name check (`stereoName === "Repeat"`) | `case "subflow"` | `subflow.action` in signature |
| HorizontalRepeat name check | `case "subflow"` | `subflow.action` in signature |

**Total removed**: ~100 lines of hardcoded logic.

---

## 2. Expression Language Grammar

A simple arithmetic expression language with variable references, function calls, and standard operators.

```
expr        := additive

additive    := multiplicative (("+" | "-") multiplicative)*

multiplicative := unary (("*" | "/" | "//" | "%") unary)*

unary       := "-" unary
            | primary

primary     := NUMBER
            | VARIABLE
            | FUNC_CALL
            | "(" expr ")"

FUNC_CALL   := IDENTIFIER "(" expr ("," expr)* ")"
```

### Tokens

| Token | Pattern | Example |
|-------|---------|---------|
| `NUMBER` | `\d+` | `784`, `3`, `0` |
| `IDENTIFIER` | `[a-zA-Z_][a-zA-Z0-9_]*` | `B`, `H`, `padding`, `kernel_size` |
| `DOLLAR_IDENT` | `\$[a-zA-Z_][a-zA-Z0-9_]*` | `$B`, `$H`, `$W` |
| `DOLLAR_STAR` | `\$\*` | `$*` (product of captured dims) |

The tokenizer must recognize `$*` as a single `DOLLAR_STAR` token, not as `DOLLAR` + `STAR`. This is unambiguous because `$` alone is never a valid token — `$` only appears as a prefix for `$IDENT` or `$*`.
| `PLUS` | `+` | |
| `MINUS` | `-` | |
| `STAR` | `*` | |
| `SLASH` | `/` | |
| `FLOOR_DIV` | `//` | |
| `PERCENT` | `%` | |
| `LPAREN` | `(` | |
| `RPAREN` | `)` | |
| `COMMA` | `,` | |

### Built-in Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `floor(x)` | `number → number` | Round down (integer) |
| `ceil(x)` | `number → number` | Round up (integer) |
| `abs(x)` | `number → number` | Absolute value |
| `max(a, b)` | `number, number → number` | Maximum of two values |
| `min(a, b)` | `number, number → number` | Minimum of two values |

Note: `product()` is intentionally absent — use `$*` for product of captured dims, or `a * b * c` for explicit multiplication. `sum()` is absent for the same reason.

### Variable Resolution Rules

| Syntax | Resolves from | Example | Meaning |
|--------|--------------|---------|---------|
| `$NAME` | Symbolic environment (`env`) | `$H` | Height dim bound during pattern matching |
| `$*` | Product of captured wildcard dims | `$*` | `128 × 7 × 7 = 6272` (Flatten) |
| `name` | Node parameters (`params`) | `kernel_size`, `padding` | Resolved via `resolveParamRef()` |

**Resolution priority**: `$`-prefixed names look only in `env`. Bare identifiers look only in `params`. No ambiguity — `$H` is always the symbolic dimension, `H` (if it existed as a param name) would be the parameter.

### Variable Resolution Context

When evaluating, variables are resolved in this priority:

1. **`$NAME`** (dollar-prefixed) → looks up `NAME` in the **symbolic environment** (e.g., `$H` → the `H` dimension bound during pattern matching). Must resolve to a const value.
2. **`$*`** → product of all **captured wildcard dimensions** that are const values. Returns `undefined` if any captured dim is non-const.
3. **bare identifier** (no `$`) → resolves from **node params** via existing `resolveParamRef()`. E.g., `kernel_size`, `padding`, `stride`.

If any variable cannot be resolved to a number, the expression is left as a deferred computed dim (unknown until params/env are set).

---

## 3. AST Types

```typescript
// front-end/src/expr/types.ts

export type BinaryOp = '+' | '-' | '*' | '/' | '//' | '%';

export type ExprNode =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: string; isSymbolic: boolean }  // isSymbolic: had $ prefix
  | { kind: 'wildcard_product' }                               // $*
  | { kind: 'binary'; op: BinaryOp; left: ExprNode; right: ExprNode }
  | { kind: 'unary'; op: '-'; operand: ExprNode }
  | { kind: 'call'; name: string; args: ExprNode[] };
```

---

## 4. File Structure

```
front-end/src/expr/
├── types.ts          — Token, ExprNode, EvalContext types
├── tokenizer.ts      — string → Token[]
├── parser.ts         — Token[] → ExprNode (recursive descent)
├── evaluator.ts      — ExprNode × EvalContext → number | undefined
├── index.ts          — public API: parseExpr(), evaluate()
└── __tests__/
    └── expr.test.ts  — unit tests for tokenizer, parser, evaluator
```

### 4.1 Evaluator Context

```typescript
export interface EvalContext {
  /** Symbolic environment from pattern matching (B, H, W, ...) */
  env: Map<string, ShapeDimension>;
  /** Wildcard-captured dimensions from pattern matching */
  captured: ShapeDimension[];
  /** Node parameters to resolve bare identifiers */
  params: Record<string, unknown>;
}
```

### 4.2 Public API

```typescript
// index.ts

/**
 * Parse an expression string into an AST.
 * Throws ParseError on syntax errors.
 */
export function parseExpr(source: string): ExprNode;

/**
 * Evaluate an expression AST to a number.
 * Returns undefined if any variable cannot be resolved.
 */
export function evaluate(
  node: ExprNode,
  context: EvalContext
): number | undefined;
```

---

## 5. Changes to Type Signature JSON

### 5.1 `computed` dimension — Before vs After

**Before** (hardcoded formula):
```json
{
  "kind": "computed",
  "formula": "conv2d_hw",
  "args": ["$H", "kernel_size", "stride", "padding", "dilation"]
}
```

**After** (expression):
```json
{
  "kind": "computed",
  "expr": "floor(($H + 2 * padding - dilation * (kernel_size - 1) - 1) / stride + 1)"
}
```

All 5 stereotypes with computed dims get updated:

| Stereotype | Old (formula + args) | New (expr) |
|-----------|---------------------|------------|
| Conv2d | `conv2d_hw` with 5 args | `floor(($H + 2*padding - dilation*(kernel_size-1) - 1)/stride + 1)` |
| MaxPool2d | `pool2d_hw` with 4 args | `floor(($H + 2*padding - kernel_size)/stride + 1)` |
| AvgPool2d | `pool2d_hw` with 4 args | `floor(($H + 2*padding - kernel_size)/stride + 1)` |
| Flatten | `flatten_prod` with `["*"]` | `$*` |
| Unsample | `upsample_hw` with 2 args | `$H * scale_factor` |

### 5.2 Join `constraints` — Before vs After

**Concat constraint** — before (hardcoded dim resolution):
```json
"constraints": {
  "concat": { "dim": "params.dim" }
}
```

After — the concat dim becomes part of the signal, not a special constraint. The join signature already handles the pattern matching. The only hardcoded part is the dimension summation on the concat axis. We make this declarative:

```json
"type_signature": {
  "kind": "join",
  "input": [
    [{"kind": "wildcard"}],
    [{"kind": "wildcard"}]
  ],
  "output": [{"kind": "wildcard"}],
  "join": {
    "action": "concat",
    "dim_expr": "dim"
  }
}
```

Where `dim` is resolved from params (same as before, but via expression evaluator).

### 5.3 Subflow Transforms — Before vs After

**Repeat** — before (hardcoded by name). The `type_signature` `[*] → [*]` already expresses shape preservation. The only change: the engine no longer checks `stereotype.name === "Repeat"`. Instead, subflows with a `type_signature` use the signature's output pattern directly (no recursive inference needed if the signature is self-contained).

```json
"type_signature": {
  "kind": "subflow",
  "subflow": {
    "action": "identity"
  },
  "input": [{"kind": "wildcard"}],
  "output": [{"kind": "wildcard"}]
}
```

`action: "identity"` means: output shape = input shape. The subflow's internal graph is NOT inferred recursively — the signature is sufficient.

**HorizontalRepeat** — before (hardcoded by name). After:

```json
"type_signature": {
  "kind": "subflow",
  "subflow": {
    "action": "infer_then_transform",
    "transform": {
      "last_dim": { "kind": "multiply", "expr": "n" }
    }
  },
  "input": [{"kind": "wildcard"}],
  "output": [{"kind": "wildcard"}]
}
```

`action: "infer_then_transform"` means: first run recursive inference on the internal graph, then apply the transform (multiply last dim by `n`).

**Generic subflow** — the default when `subflow.action` is absent (or `"infer"`):
```json
"type_signature": {
  "kind": "subflow",
  "subflow": {
    "action": "infer"
  }
}
```
Or simply no `type_signature` at all → engine runs recursive inference (current behavior).

---

## 6. Expression Caching & Error Handling

### 6.1 Parse-on-first-use with caching

Expressions are parsed lazily and cached in a module-level `Map<string, ExprNode>`:

```typescript
const parsedCache = new Map<string, ExprNode>();

function getOrParse(expr: string): ExprNode {
  const cached = parsedCache.get(expr);
  if (cached) return cached;
  const ast = parseExpr(expr);
  parsedCache.set(expr, ast);
  return ast;
}
```

Expressions are tiny (10-50 chars) so parsing is negligible, but the cache avoids re-parsing the same formula on every inference pass.

### 6.2 Parse errors → type errors

If `parseExpr` throws `ParseError`, the engine wraps it as a `TypeError`:

```typescript
try {
  const ast = getOrParse(p.expr);
  const value = evaluate(ast, context);
  // ...
} catch (e) {
  if (e instanceof ParseError) {
    // Malformed expression in stereotype JSON — bug in the stereotype definition
    console.error(`Invalid expr in stereotype: ${e.message}`);
    // Keep as deferred computed dim (graceful degradation)
    result.push({ kind: "computed", expr: p.expr });
  }
}
```

### 6.3 Unresolved variables → deferred dim

If `evaluate()` returns `undefined` (any variable cannot be resolved to a number), the computed dim is kept as deferred `{ kind: "computed", expr: "..." }` — same behavior as before with the old formula system.

---

## 7. Engine Changes

### 6.1 `resolvePattern()` — computed dims

Replace the `case "computed"` block:

```typescript
case "computed": {
  if (p.expr) {
    // New path: evaluate expression
    const context: EvalContext = { env, captured, params };
    const value = evaluate(parseExpr(p.expr), context);
    if (value !== undefined) {
      result.push({ kind: "const", value });
    } else {
      // Keep as deferred computed dim (unresolved vars)
      result.push({ kind: "computed", expr: p.expr });
    }
  } else if (p.formula) {
    // LEGACY: old formula-based computed dims (remove after migration)
    // ... existing logic using resolveComputedArg + resolveFormula ...
  }
  break;
}
```

### 6.2 `inferNode()` — subflow case

Replace hardcoded name checks with `sig.subflow` config:

```typescript
case "subflow": {
  const subCfg = sig.subflow;
  const action = subCfg?.action ?? "infer"; // default for generic subflows

  switch (action) {
    case "identity":
      // Shape-preserving (Repeat equivalent)
      // input pattern and output pattern both wildcard → use inputType directly
      return { shape: inputType.shape.map(d => ({...d})), dtype: inputType.dtype };

    case "infer":
      // Generic subflow: recursive inference
      return this.inferSubflow(nodeId, inputType, diagram, params, env, annotations, errors);

    case "infer_then_transform":
      // HorizontalRepeat equivalent: infer internal, then transform
      const internalResult = this.inferSubflow(nodeId, inputType, diagram, params, env, annotations, errors);
      if (isTypeError(internalResult)) return internalResult;
      // Apply transform
      if (subCfg?.transform?.last_dim?.kind === "multiply") {
        const nExpr = subCfg.transform.last_dim.expr;
        const context: EvalContext = { env, captured: [], params };
        const n = evaluate(parseExpr(nExpr), context);
        if (n === undefined) return error("cannot resolve n");
        // multiply last dim
        const newShape = internalResult.shape.map((d, i, arr) => {
          if (i === arr.length - 1 && d.kind === 'const') {
            return { kind: 'const' as const, value: d.value * n };
          }
          return { ...d };
        });
        return { shape: newShape, dtype: internalResult.dtype };
      }
      return internalResult; // fallback: no transform
  }
}
```

### 6.3 `inferNode()` — join case

Replace hardcoded `sig.constraints?.concat` check:

```typescript
case "join": {
  // ... existing multi-input pattern matching ...
  
  const joinCfg = sig.join;
  if (joinCfg?.action === "concat") {
    const dimExpr = joinCfg.dim_expr ?? "-1";
    const context: EvalContext = { env, captured: [], params };
    const concatDim = evaluate(parseExpr(dimExpr), context);
    // ... resolve concatDim, compute output ...
  }
  // ... standard join output ...
}
```

### 6.4 Remove: `resolveFormula()`, `resolveComputedArg()`, `resolveConcatDim()`, `resolveConcatOutput()`

These four methods become dead code after the migration.

---

## 7. TypeScript Type Updates

### 7.1 `tensortypes.ts`

```typescript
// OLD computed dim pattern
export type ShapeDimPattern =
  | { kind: 'computed'; formula: string; args: string[] }
  // ...

// NEW: expression field takes precedence
export type ShapeDimPattern =
  | { kind: 'computed'; expr?: string; formula?: string; args?: string[] }
  // ...
```

### 7.2 New interfaces

```typescript
/** Subflow transform descriptor */
export interface SubflowConfig {
  action: 'identity' | 'infer' | 'infer_then_transform';
  transform?: SubflowTransform;
}

export interface SubflowTransform {
  last_dim?: {
    kind: 'multiply';
    expr: string;
  };
}

/** Join operation descriptor */
export interface JoinConfig {
  action?: 'element_wise' | 'concat' | 'matmul';
  dim_expr?: string;  // for concat: which dim to concat on
}
```

### 7.3 Updated TypeSignature

```typescript
export interface TypeSignature {
  kind: 'module' | 'join' | 'subflow';
  input: ShapePattern | ShapePattern[];
  output: ShapePattern;
  dtype?: { input?: DType; output?: DType };
  subflow?: SubflowConfig;   // NEW
  join?: JoinConfig;          // NEW
  constraints?: {             // DEPRECATED — kept for backward compat
    concat?: { dim: string };
    hrepeat?: { n: string };
  };
}
```

---

## 8. Migration Path (Incremental)

### Phase A — Expression Evaluator (this task)
1. Create `front-end/src/expr/` with tokenizer, parser, evaluator, types, tests
2. Integrate evaluator into `typeEngine.ts` `resolvePattern()` — use `expr` when present, fallback to `formula`/`args`
3. Update 5 stereotype JSONs (Conv2d, MaxPool2d, AvgPool2d, Flatten, Unsample) to use `expr`
4. Remove `resolveFormula()` and `resolveComputedArg()`
5. Tests: 15+ expression tests + verify existing computed dim tests still pass

### Phase B — Declarative Subflow (next task)
1. Add `SubflowConfig` to `TypeSignature`
2. Replace hardcoded name checks in `case "subflow"` with `sig.subflow.action`
3. Update Repeat.json and HorizontalRepeat.json with `subflow` config
4. Remove hardcoded Repeat/HorizontalRepeat branches

### Phase C — Declarative Join (next task)
1. Add `JoinConfig` to `TypeSignature`
2. Replace hardcoded `constraints.concat` check with `sig.join.action === "concat"`
3. Remove `resolveConcatDim()`, `resolveConcatOutput()`
4. Update Concat.json

---

## 9. Test Plan

### 9.1 Expression Evaluator Tests (Group 10)

```
10.1  parseExpr("42") → { kind: 'number', value: 42 }
10.2  parseExpr("$H + 1") → binary(+, variable(H,true), number(1))
10.3  parseExpr("2 * padding - 1") → binary(-, binary(*, 2, variable(padding)), 1)
10.4  parseExpr("floor(($H + 3) / 2)") → call(floor, [binary(/, binary(+, var(H), 3), 2)])
10.5  parseExpr("a + b * c") → correct precedence (a + (b * c))
10.6  parseExpr("(a + b) * c") → correct grouping
10.7  parseExpr("- x") → unary minus
10.8  parseExpr("a // b") → floor division
10.9  evaluate with env: {H: 32} → "floor(($H + 3) / 2)" → 17
10.10 evaluate with params: {padding: 1, stride: 1} → "(2*padding)/stride + 1" → 3
10.11 evaluate with captured: [28, 28] → "$*" → 784
10.12 evaluate with unresolved var → undefined
10.13 parseExpr("$*") → { kind: 'wildcard_product' }
10.14 conv2d full expression: produces correct output dim
10.15 syntax error: "2 +" → ParseError
10.16 syntax error: "floor(1,)" → ParseError
```

### 9.2 Integration Tests

- All existing computed dim tests (Group 6) must pass unchanged
- All existing join tests (Group 7) must pass unchanged  
- All existing subflow tests (Group 8) must pass unchanged
- All existing complex module tests (Group 9) must pass unchanged

---

## 10. Files to Create/Modify

### Created (7 files)
| File | Purpose |
|------|---------|
| `front-end/src/expr/types.ts` | Token, ExprNode, EvalContext types |
| `front-end/src/expr/tokenizer.ts` | String → Token[] lexer |
| `front-end/src/expr/parser.ts` | Recursive descent parser |
| `front-end/src/expr/evaluator.ts` | AST evaluator |
| `front-end/src/expr/index.ts` | Public API: parseExpr, evaluate |
| `front-end/src/__tests__/expr.test.ts` | 16+ expression tests |

### Modified (7 files)
| File | Change |
|------|--------|
| `front-end/src/conversion/typeEngine.ts` | Integrate evaluator; remove `resolveFormula`, `resolveComputedArg` |
| `front-end/src/conversion/tensortypes.ts` | Add `SubflowConfig`, `JoinConfig`; update `ShapeDimPattern` |
| `Stereotypes/Modules/Conv2d.json` | Replace `formula`+`args` with `expr` |
| `Stereotypes/Modules/MaxPool2d.json` | Same |
| `Stereotypes/Modules/AvgPool2d.json` | Same |
| `Stereotypes/Modules/Flatten.json` | Same |
| `Stereotypes/Modules/Unsample.json` | Same |

---
