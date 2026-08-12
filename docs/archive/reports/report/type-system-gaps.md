# Type System Gaps — Analysis and Implementation Roadmap

> Historical backlog and design notes. Several examples and unchecked items
> below predate the current implementation. In particular, `TypeResult` now
> already includes warnings and suggestions, and node annotations may carry
> `blockedBy` upstream error provenance. Consult `docs2/source/type_system.rst`
> and `front-end/src/conversion/tensortypes.ts` for the current contract.

**Status**: Analysis  
**Date**: 2026-07-15  
**Author**: opencode (auto-generated)

---

## Executive Summary

The NNModelling type system provides real-time tensor shape validation across 36
stereotypes using a data-driven, constraint-based approach. This document
identifies 8 gaps in the current system, analyzes each in detail, and proposes
implementation strategies that maintain the "no special cases" principle — all
logic should be declarative, driven by stereotype JSON, with no hardcoded module
names in the TypeScript engine.

---

## Gap 1: Batch Dimension ($B) Never Unified

### Problem

The symbolic `$B` dimension is bound per-node but never validated across the
graph. A node producing `[32, 100]` can feed into a node expecting `[64, *]`
without any error. The batch dimension is the most fundamental invariant in
deep learning — batch size must be consistent across the entire forward pass.

### Current Behavior

```
Input(out_features=100) → [B, 100]
Linear(in=100, out=50)  → [B, 50]    // $B bound to whatever Input produced
Linear(in=50, out=10)   → [B, 10]    // $B still bound, no conflict check
```

If somehow two different `$B` bindings existed (e.g. from a Join with
incompatible batch dims), the engine would silently use the first binding.

### Root Cause

`$B` is treated as an opaque symbolic name. The engine binds it during pattern
matching but never checks that the same symbolic name has consistent values
across the entire graph. Unification only happens within a single node's
pattern match — not across nodes.

### Implementation Idea

**Cross-node symbolic unification.** After the full-graph topological
traversal, run a validation pass that checks all bindings of the same symbolic
name are consistent:

```typescript
// After infer() completes:
for (const [name, binding] of env) {
  // Find all nodes that bind this symbol
  const bindings = annotations.values()
    .flatMap(ann => [ann.inputType, ann.outputType])
    .filter(t => t !== undefined)
    .flatMap(t => t!.shape)
    .filter(d => d.kind === 'symbolic' && d.name === name);
  
  // All bindings must be equal (dimEqual)
  // If conflicting → error
}
```

**Declarative approach**: Add an optional `global` flag to symbolic dimension
patterns in the type signature:

```json
{ "kind": "symbolic", "name": "$B", "global": true }
```

When `global: true`, the engine enforces that this symbolic name has a
consistent value across all nodes in the graph. This is still data-driven —
each stereotype declares which dimensions must be globally consistent.

**Complexity**: Low. The infrastructure for symbolic unification already exists
within `patternMatch`. The missing piece is a graph-level validation pass.

---

## Gap 2: Dtype Propagation Absent

### Problem

The type system tracks `dtype` as a string field on `TensorType`, but it is
almost always `"unknown"`. No stereotype declares dtype constraints, and no
validation checks for dtype mismatches. This means:

- `float16` tensors flowing into `float32` operations go undetected
- Index tensors (`int64`) used as gather indices aren't validated
- Mixed-precision training issues are invisible until runtime

### Current State

Every stereotype's `type_signature` has an optional `dtype` field:

```typescript
dtype?: {
  input?: DType;
  output?: DType;
};
```

But no stereotype uses it. The `inferNode` method does `sig.dtype?.output ?? inputType.dtype` — it just passes through whatever the input provides.

### The Dual Nature of `dtype`

`dtype` plays two distinct roles that must not be conflated:

**Role 1 — Constructor parameter.** In PyTorch, most modules accept `dtype` as
a constructor argument:

```python
nn.Linear(784, 100, dtype=torch.float32)
nn.Embedding(1000, 64, dtype=torch.float16)
```

This is what the user sets in the visual editor. It lives in `params.dtype`
and gets passed to `convert.py` → Hydra config → `nn.Module.__init__()`.

**Role 2 — Type system property.** The ACTUAL dtype of a tensor flowing
through the graph may differ from the constructor parameter:

- Autocast changes dtypes dynamically (float32 → float16)
- `.float()`, `.half()`, `.to(dtype)` calls override the module's dtype
- Some operations change dtype (e.g. `CrossEntropyLoss` expects float input
  but targets are int64)

The type system needs to track the ACTUAL dtype, not just echo the constructor
parameter.

### Why `dtype` Should Stay as a Parameter

Removing `dtype` from `params` would break codegen — PyTorch modules need it
in `__init__()`. But we should treat it as a **code-generation parameter**,
not a **type-checking parameter**.

### Implementation Idea

**Separate three concerns:**

1. **`params.dtype`** (existing) — constructor parameter for codegen. Values:
   `"float32"`, `"float16"`, `"bfloat16"`, `"None"` (default). This stays
   as-is in the JSON.

2. **`type_signature.dtype`** (existing, unused) — declares the module's dtype
   CONTRACT. What dtypes it accepts as input and produces as output. This is
   for the type engine.

3. **Inferred dtype** (new) — the ACTUAL dtype of the tensor at each point in
   the graph, computed by the type engine.

**Phase 1: Dtype contracts in stereotypes.** Add dtype constraints using the
existing `type_signature.dtype` field:

```json
// Embedding.json
"type_signature": {
  "kind": "module",
  "input": [...],
  "output": [...],
  "dtype": {
    "input": "int64",
    "output": "float32"
  }
}

// BatchNorm1d.json
"type_signature": {
  "dtype": {
    "input": "float32",
    "output": "float32"
  }
}

// CrossEntropyLoss.json
"type_signature": {
  "dtype": {
    "input": "float32",
    "target_dtype": "int64"
  }
}
```

The `dtype.input`/`dtype.output` fields declare what the module REQUIRES and
PRODUCES, regardless of what `params.dtype` says.

**Phase 2: Dtype inference engine.** During `inferNode`, after shape inference:

1. Resolve input dtype from predecessor's output dtype
2. Check against declared `dtype.input` constraint — if mismatch → error
3. Set output dtype from `dtype.output` or propagate input dtype
4. `params.dtype` is IGNORED for type checking (it's for codegen only)

**Phase 3: Dtype coercion suggestions.** When a mismatch is detected, suggest
a Cast node: "BatchNorm expects float32 but receives int64 — insert a Cast
node?"

**Key distinction:**

| Concern | Source | Used By |
|---------|--------|---------|
| Constructor dtype | `params.dtype` | Codegen (`convert.py`) |
| Expected input dtype | `type_signature.dtype.input` | Type engine |
| Produced output dtype | `type_signature.dtype.output` | Type engine |
| Actual tensor dtype | Inferred during traversal | Type engine |

**Backend handling.** The Python codegen (`convert.py`) already reads
`params.dtype` and passes it to the module constructor. No changes needed
there. The type engine uses `type_signature.dtype` for validation — these are
independent.

**Complexity**: Medium. The engine infrastructure exists; the work is declaring
contracts in stereotype JSONs and adding a dtype check in `inferNode`. The
`params.dtype` parameter stays as-is for codegen compatibility.

---

## Gap 3: Einsum Without Special Cases

### Problem

`Einsum` is the only stereotype without a `type_signature`. Einstein notation
is inherently expression-based: `"ij,jk->ik"` defines both the operation and
the shape contract. The current type system cannot parse or evaluate Einstein
strings.

### Why Special Cases Are Tempting (But Wrong)

One could add `if (stereotype.pythonClassName === "nn.Einsum") { ... }` in the
engine. But this violates the data-driven principle — every other module is
handled purely through JSON. Einsum should be no different.

### Implementation Idea: Extend the Expression Language

The expression language already handles arithmetic, symbolic variables, and
functions. Einstein notation is another DSL that can be parsed and evaluated.

**Step 1: Einsum parser (new module `front-end/src/einsum/`)**

Parse an Einstein equation like `"ij,jk->ik"` into a structured representation:

```typescript
interface EinsumSpec {
  inputs: string[][];     // [["i","j"], ["j","k"]]
  output: string[];       // ["i","k"]
  contractionDims: string[];  // ["j"] — dims in inputs but not output
  freeDims: string[];         // ["i","k"] — dims in output
}
```

This is a pure parser — no hardcoded module names, no special cases.

**Step 2: New pattern kind `einsum`**

Add to `ShapeDimPattern`:

```typescript
| { kind: 'einsum'; param: string; dim: string }
```

Where `param` is the node parameter containing the Einstein string (e.g.
`"expr"`) and `dim` is which dimension of the output to compute (e.g. `"i"`
or `"k"`).

**Step 3: Stereotype JSON**

```json
{
  "category": "Join",
  "pythonClassName": "nn.Einsum",
  "params": {
    "expr": { "type": "str", "default": "Undefined" }
  },
  "type_signature": {
    "kind": "join",
    "input": [
      [{ "kind": "einsum", "param": "expr", "dim": "i" },
       { "kind": "einsum", "param": "expr", "dim": "j" }],
      [{ "kind": "einsum", "param": "expr", "dim": "j" },
       { "kind": "einsum", "param": "expr", "dim": "k" }]
    ],
    "output": [
      { "kind": "einsum", "param": "expr", "dim": "i" },
      { "kind": "einsum", "param": "expr", "dim": "k" }
    ]
  }
}
```

**How it works:**

1. Engine reads `expr = "ij,jk->ik"`
2. Parser produces `{ inputs: [["i","j"], ["j","k"]], output: ["i","k"], contractionDims: ["j"] }`
3. For each input pattern, match the dimensions against the input tensor
4. For output pattern, produce dimensions from the free variables
5. Contraction dims are validated to match across inputs

**Step 4: Type engine handling**

In `patternMatch`, `einsum` works like a `symbolic` but the binding comes from
the Einstein string rather than being free. In `resolvePattern`, `einsum`
resolves to the bound dimension value.

**Advantages over special case:**

- Data-driven: the Einstein string is a parameter, not hardcoded
- Reusable: any module using Einstein notation (e.g. `torch.einsum`) works
- Testable: the parser is independent of the type engine
- Consistent: same pattern matching infrastructure as all other modules

**Complexity**: High. Requires a new parser module and a new pattern kind. But
the result is a general mechanism that could also handle other
parameter-defined shape contracts.

---

## Gap 4: No "Reasonable Shape" Validation

### Problem

The type system validates *compatibility* (dimensions match) but not
*reasonableness* (dimensions make sense). Examples:

- `Conv2d(kernel_size=32)` on a `16×16` input — kernel larger than input
- `Flatten → Flatten` — redundant, no-op
- `Linear(1000→10)` after `Conv2d(3→1000)` — extreme bottleneck
- `Dropout(p=1.0)` — drops everything, output is always zero

### Why This Matters

These aren't type errors — the shapes are technically compatible. But they
indicate user mistakes that will cause training issues (dead gradients,
memory explosions, useless layers).

### Implementation Idea: Advisory Warnings

Add a `warnings` array to `TypeResult` (separate from `errors`):

```typescript
interface TypeResult {
  ok: boolean;
  annotations: Map<string, NodeTypeAnnotation>;
  errors: TypeError[];
  warnings: TypeWarning[];  // NEW
}

interface TypeWarning {
  nodeId: string;
  message: string;
  kind: 'advisory' | 'perf' | 'style';
}
```

**Declarative warnings in stereotype JSON.** Add an optional `advisories`
field:

```json
{
  "type_signature": { ... },
  "advisories": [
    {
      "condition": "kernel_size > $H || kernel_size > $W",
      "message": "kernel_size exceeds input spatial dimensions",
      "kind": "perf"
    }
  ]
}
```

The condition is evaluated using the existing expression language. If true, a
warning is emitted. This is fully data-driven — each stereotype declares its
own advisories.

**Priority advisories:**

- Conv2d: kernel > input
- Dropout: p > 0.5
- Linear: extreme compression ratio (in/out > 100)
- Flatten → Flatten (redundant)
- Loss node with no downstream (training graph has no objective)

**Complexity**: Low. The expression evaluator already exists. The work is
adding the advisory infrastructure and declaring conditions in JSONs.

---

## Gap 5: Dynamic Shapes (Variable-Length Sequences)

### Problem

All shapes are static. There's no way to express:

- "Sequence length varies between batches"
- "Input image size is flexible (224×224 or 256×256)"
- "Output length depends on input length (autoencoder)"

The type system treats `$L` (sequence length) as a fixed symbolic — once bound,
it must match everywhere. But in practice, `$L` is a *dimension class* (can be
any value), not a *specific value*.

### Current Behavior

```
Embedding(vocab=1000, dim=64) → [B, L, 64]
PositionalEncoding(d=64)      → [B, L, 64]     // $L must match
TransformerEncoderLayer(...)   → [B, L, 64]     // $L must match
```

This works if all nodes see the same `$L`. But if you want a model that works
with `L=50` at training and `L=100` at inference, the type system can't express
that `$L` is variable.

### Implementation Idea: Dimension Classes

Add a `dimension_class` attribute to symbolic patterns:

```json
{ "kind": "symbolic", "name": "$L", "class": "variable" }
```

When `class: "variable"`:

- The dimension is NOT unified across nodes (each node can have its own `$L`)
- Instead, only the *rank* is validated (must be the same number of dims)
- The expression language can still compute output dims from `$L`

When `class: "fixed"` (default):

- Current behavior: unified across all nodes, must be consistent

This lets the type system distinguish between:

- `$B` (batch) — must be fixed across the graph
- `$L` (sequence length) — can vary per node
- `$H`, `$W` (spatial) — can vary per node

**Complexity**: Medium. Requires adding the `class` attribute and modifying
unification logic to skip variable-class symbols.

---

## Gap 6: No Shape Suggestions

### Problem

When a parameter is `Undefined`, the type system produces a symbolic output
(`?in_features`). It could instead suggest a concrete value based on the input
shape. For example:

- Linear after Input(784) → "Try `in_features=784`"
- Conv2d after Input(1,28,28) → "Try `in_channels=1`"
- Linear after ReLU with output [B, 256] → "Try `in_features=256`"

### Implementation Idea: Constraint-Based Suggestions

During `inferNode`, when a parameter is unset:

1. Look at the input type's shape
2. Find which dimension position the parameter maps to (from the type signature)
3. Suggest the concrete value from that position

```typescript
// In patternMatch, when param_ref is unset:
if (resolved.status === 'unset') {
  // Look at inputDims[i] — what dimension is at this position?
  const inputDim = inputDims[i];
  if (inputDim.kind === 'const') {
    suggestions.push({
      param: p.name,
      value: inputDim.value,
      reason: `input dimension at position ${j} is ${inputDim.value}`
    });
  }
}
```

Add to `TypeResult`:

```typescript
interface TypeResult {
  ok: boolean;
  annotations: Map<string, NodeTypeAnnotation>;
  errors: TypeError[];
  suggestions: TypeSuggestion[];  // NEW
}

interface TypeSuggestion {
  nodeId: string;
  param: string;
  value: number;
  reason: string;
}
```

**UI integration**: The Sidebar could show "Suggested: in_features=784" next to
the unset parameter, with a click-to-apply button.

**Complexity**: Low. The information is already available in the pattern match.
The work is collecting suggestions and exposing them in the UI.

---

## Gap 7: MatMul Join Ordering Not Verified

### Problem

`MatMul` is non-commutative: `A×B ≠ B×A`. The type engine checks that the K
dimension matches across inputs, but doesn't verify that the inputs are in the
correct order. Example:

```
Linear(784→256) → [B, 256]    // A
Linear(784→128) → [B, 128]    // B
MatMul                      // Should be A×B^T or something?
```

The engine sees `[B, 256]` and `[B, 128]` — it checks that the last dims
match (they don't, so it would error). But for valid MatMul like
`[B, 256, 128] × [B, 128, 64]`, the engine checks that K=128 matches but
doesn't verify that the first input's last dim equals the second input's
second-to-last dim.

### Current Behavior

The `MatMul` stereotype has:

```json
"type_signature": {
  "kind": "join",
  "input": [
    [{ "kind": "symbolic", "name": "$B" },
     { "kind": "symbolic", "name": "$M" },
     { "kind": "symbolic", "name": "$K" }],
    [{ "kind": "symbolic", "name": "$B" },
     { "kind": "symbolic", "name": "$K" },
     { "kind": "symbolic", "name": "$N" }]
  ],
  "output": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$M" },
    { "kind": "symbolic", "name": "$N" }
  ]
}
```

This is actually correct — `$K` is unified across both inputs, and the output
is `[B, M, N]`. The ordering is implicit in the pattern structure.

### The Real Issue

The issue is not with MatMul itself, but with how Join input ordering maps to
the pattern. Join nodes have `targetHandle` labels (`in-0`, `in-1`) that
determine which input tensor goes to which pattern position. If the user
connects inputs in the wrong order, the type engine would still try to match
them against the patterns.

Currently, the engine sorts edges by `targetHandle` and matches them against
patterns in order. So `in-0` → pattern[0], `in-1` → pattern[1]. This is
correct IF the user connects inputs in the right order.

### Implementation Idea: Join Input Validation

Add a `join_order` constraint to the type signature:

```json
{
  "kind": "join",
  "join": {
    "action": "matmul",
    "input_labels": ["A", "B"]
  },
  "input": [
    [{ "kind": "symbolic", "name": "$B" },
     { "kind": "symbolic", "name": "$M" },
     { "kind": "symbolic", "name": "$K" }],
    [{ "kind": "symbolic", "name": "$B" },
     { "kind": "symbolic", "name": "$K" },
     { "kind": "symbolic", "name": "$N" }]
  ]
}
```

The `input_labels` field provides human-readable names for the inputs. When a
shape mismatch occurs, the error message can say: "MatMul input A expects
[B, M, K] but got [B, 128] — did you connect the inputs in the wrong order?"

This is advisory, not enforcement — the user might intentionally want
`B×A^T`. But the better error message helps debugging.

**Complexity**: Low. The labels are just metadata for error messages.

---

## Gap 8: No nn.Sequential / nn.ModuleList Support

### Problem

PyTorch's `nn.Sequential` and `nn.ModuleList` are fundamental building blocks.
In NNModelling, the `Repeat` subflow creates N copies with independent weights.
But there's no way to model:

- A block repeated N times with shared weights (parameter tying)
- A dynamic list of modules (length determined at runtime)
- A module selected from a list based on a condition

### Current State

`Repeat` subflow: N copies of a subgraph, each with independent parameters.
This maps to `ops.Repeat` which creates N independent `nn.Module` instances.

`HorizontalRepeat`: N parallel copies with independent weights, output
concatenated.

Neither supports weight sharing.

### Implementation Idea: Shared Weights Subflow

Add a `weight_sharing` option to the SubflowConfig:

```json
{
  "type_signature": {
    "kind": "subflow",
    "subflow": {
      "action": "identity",
      "weight_sharing": true
    }
  }
}
```

When `weight_sharing: true`:

- The subflow is instantiated once
- All N copies share the same `nn.Module` parameters
- The Python ops layer uses `torch.nn.utils.weight_norm` or manual parameter
  sharing

This requires changes to:

1. `tensortypes.ts` — extend `SubflowConfig`
2. `typeEngine.ts` — handle weight_sharing in subflow inference
3. `ops/repeat.py` — add shared-weight variant
4. `net/base.py` — handle shared-weight subflows in the forward pass

**Complexity**: Medium-High. Requires Python-side changes in `converted/`.

---

## Priority Matrix

| Gap | Impact | Effort | Priority |
|-----|--------|--------|----------|
| 1. Batch unification | High | Low | **P0** |
| 2. Dtype propagation | High | Medium | **P1** |
| 3. Einsum | High | High | **P1** |
| 6. Shape suggestions | Medium | Low | **P1** |
| 4. Reasonable shapes | Medium | Low | P2 |
| 5. Dynamic shapes | Medium | Medium | P2 |
| 7. MatMul ordering | Low | Low | P3 |
| 8. Sequential/weight sharing | High | High | P3 |

---

## Recommended Implementation Order

### Phase 18 — Batch Unification (Gap 1)

1. Add `global` flag to symbolic patterns in `tensortypes.ts`
2. Add post-inference validation pass in `typeEngine.ts` that checks global
   symbolic consistency
3. Update Input, Linear, Conv2d, Conv1d, Embedding stereotypes to mark `$B`
   as global
4. Add tests: conflicting batch sizes produce errors
5. Estimated: ~100 lines TypeScript, ~10 tests

### Phase 19 — Shape Suggestions (Gap 6)

1. Add `suggestions` array to `TypeResult` in `tensortypes.ts`
2. In `patternMatch`, when `param_ref` is unset, look at input dim and suggest
3. Expose suggestions in `BrowserRPCHandler` → Sidebar UI
4. Estimated: ~80 lines TypeScript, ~6 tests

### Phase 20 — Dtype Propagation (Gap 2)

1. Add `dtype` constraints to 10 key stereotypes (Embedding, BatchNorm,
   LayerNorm, CrossEntropyLoss, MSELoss, etc.)
2. Add dtype checking in `inferNode` after shape inference
3. Add dtype mismatch errors
4. Estimated: ~150 lines TypeScript, ~15 tests

### Phase 21 — Einsum (Gap 3)

1. Create `front-end/src/einsum/` module with parser
2. Add `einsum` pattern kind to `tensortypes.ts`
3. Handle `einsum` in `patternMatch` and `resolvePattern`
4. Update `Einsum.json` stereotype with type_signature
5. Estimated: ~300 lines TypeScript, ~20 tests

---

## Appendix: Files to Modify

| Phase | Files |
|-------|-------|
| 18 | `tensortypes.ts`, `typeEngine.ts`, stereotype JSONs, `typeEngine.test.ts` |
| 19 | `tensortypes.ts`, `typeEngine.ts`, `BrowserRPCHandler.ts`, `Sidebar.svelte`, `typeEngine.test.ts` |
| 20 | `tensortypes.ts`, `typeEngine.ts`, stereotype JSONs, `typeEngine.test.ts` |
| 21 | New `einsum/` module, `tensortypes.ts`, `typeEngine.ts`, `Einsum.json`, `typeEngine.test.ts` |

---

## TODO — Implementation Phases

- [ ] **Phase 18 — Batch Unification (Gap 1)**
  - [ ] Add `global` flag to `ShapeDimPattern` in `tensortypes.ts`
  - [ ] Add `global` variant to `ShapeDimension` in `tensortypes.ts`
  - [ ] Add post-inference validation pass in `typeEngine.ts`
  - [ ] Handle `global` in `patternMatch()` — bind but mark as global
  - [ ] Handle `global` in `resolvePattern()` — resolve as normal
  - [ ] Add `checkGlobalUnification()` method to TypeEngine
  - [ ] Update `Input.json`: `{ "kind": "symbolic", "name": "$B", "global": true }`
  - [ ] Update `Linear.json`: mark `$B` as global
  - [ ] Update `Conv1d.json`, `Conv2d.json`: mark `$B` as global
  - [ ] Update `Embedding.json`: mark `$B` as global
  - [ ] Update all other stereotypes with `$B`: mark as global
  - [ ] Add test: conflicting batch sizes (B=32 vs B=64) → error
  - [ ] Add test: consistent batch sizes → success
  - [ ] Add test: batch unification across subflows
  - [ ] Estimated: ~100 lines TypeScript, ~10 tests

- [ ] **Phase 19 — Shape Suggestions (Gap 6)**
  - [ ] Add `TypeSuggestion` interface to `tensortypes.ts`
  - [ ] Add `suggestions: TypeSuggestion[]` to `TypeResult`
  - [ ] In `patternMatch`, when `param_ref` is unset, look at `inputDims[i]`
  - [ ] If input dim is `const`, suggest that value for the param
  - [ ] Collect suggestions in `inferNode` return
  - [ ] Add `suggestions` to `infer()` result aggregation
  - [ ] Expose suggestions in `BrowserRPCHandler.ts`
  - [ ] Add suggestions panel in `Sidebar.svelte`
  - [ ] Add test: Linear after Input(784) → suggest in_features=784
  - [ ] Add test: Conv2d after Input(1,28,28) → suggest in_channels=1
  - [ ] Estimated: ~80 lines TypeScript, ~6 tests

- [ ] **Phase 20 — Dtype Propagation (Gap 2)**
  - [ ] Add `dtype` constraints to `Embedding.json` (input: int64, output: float32)
  - [ ] Add `dtype` constraints to `BatchNorm1d.json` (input: float32, output: float32)
  - [ ] Add `dtype` constraints to `BatchNorm2d.json` (input: float32, output: float32)
  - [ ] Add `dtype` constraints to `LayerNorm.json` (input: float32, output: float32)
  - [ ] Add `dtype` constraints to `CrossEntropyLoss.json` (input: float32, target: int64)
  - [ ] Add `dtype` constraints to `MSELoss.json` (input: float32)
  - [ ] Add `dtype` constraints to `BCELoss.json` (input: float32)
  - [ ] Add `dtype` constraints to `BCEWithLogitsLoss.json` (input: float32)
  - [ ] Add `dtype` constraints to `Dropout.json` (input: float32, output: float32)
  - [ ] Add `dtype` constraints to `Softmax.json` (input: float32, output: float32)
  - [ ] Add dtype resolution in `inferNode` — propagate from predecessor
  - [ ] Add dtype validation in `inferNode` — check against `sig.dtype.input`
  - [ ] Add dtype output in `inferNode` — use `sig.dtype.output` or propagate
  - [ ] Add `DTypeError` interface to `tensortypes.ts`
  - [ ] Add dtype errors to `TypeResult.errors`
  - [ ] Add test: Embedding with float input → dtype error
  - [ ] Add test: BatchNorm with int input → dtype error
  - [ ] Add test: dtype propagation through chain
  - [ ] Add test: dtype mismatch at join node
  - [ ] Estimated: ~150 lines TypeScript, ~15 tests

- [ ] **Phase 21 — Einsum (Gap 3)**
  - [ ] Create `front-end/src/einsum/types.ts` — `EinsumSpec` interface
  - [ ] Create `front-end/src/einsum/parser.ts` — parse `"ij,jk->ik"` strings
  - [ ] Create `front-end/src/einsum/index.ts` — public API
  - [ ] Add `einsum` pattern kind to `ShapeDimPattern` in `tensortypes.ts`
  - [ ] Add `einsum` to `ShapeDimension` in `tensortypes.ts`
  - [ ] Handle `einsum` in `patternMatch()` — resolve dims from Einstein string
  - [ ] Handle `einsum` in `resolvePattern()` — produce output dims
  - [ ] Update `Einsum.json` stereotype with `type_signature`
  - [ ] Add test: parse `"ij,jk->ik"` correctly
  - [ ] Add test: parse `"ij,jk,kl->il"` (3 inputs)
  - [ ] Add test: parse `"ii->"` (trace)
  - [ ] Add test: MatMul via Einsum `"ij,jk->ik"` shape inference
  - [ ] Add test: batched Einsum `"bij,bjk->bik"`
  - [ ] Add test: Einsum error on invalid expression
  - [ ] Estimated: ~300 lines TypeScript, ~20 tests

- [ ] **Phase 22 — Reasonable Shape Advisories (Gap 4)**
  - [ ] Add `TypeWarning` interface to `tensortypes.ts`
  - [ ] Add `warnings: TypeWarning[]` to `TypeResult`
  - [ ] Add `advisories` field to stereotype JSON schema
  - [ ] Add advisory evaluation in `inferNode` using expression language
  - [ ] Add advisory to `Conv2d.json`: kernel_size > input spatial dims
  - [ ] Add advisory to `Dropout.json`: p > 0.5
  - [ ] Add advisory for redundant Flatten→Flatten
  - [ ] Add advisory for extreme compression ratio in Linear
  - [ ] Expose warnings in Sidebar UI (yellow indicators)
  - [ ] Estimated: ~120 lines TypeScript, ~10 tests

- [ ] **Phase 23 — Dynamic Shapes (Gap 5)**
  - [ ] Add `class` attribute to `ShapeDimPattern` symbolic variant
  - [ ] Add `'fixed' | 'variable'` to symbolic pattern type
  - [ ] Modify unification in `patternMatch` to skip variable-class symbols
  - [ ] Update `Embedding.json`: `$L` as variable class
  - [ ] Update `Transformer.json`: `$L` as variable class
  - [ ] Update `PositionalEncoding.json`: `$L` as variable class
  - [ ] Add test: variable `$L` across nodes → no error
  - [ ] Add test: fixed `$B` across nodes → must match
  - [ ] Estimated: ~100 lines TypeScript, ~8 tests

- [ ] **Phase 24 — MatMul Join Ordering (Gap 7)**
  - [ ] Add `input_labels` to `JoinConfig` in `tensortypes.ts`
  - [ ] Update `MatMul.json`: `"input_labels": ["A", "B"]`
  - [ ] Update `ScaledDotProduct.json`: `"input_labels": ["Q", "K", "V"]`
  - [ ] Improve error messages with input labels
  - [ ] Add test: MatMul shape error mentions "input A" / "input B"
  - [ ] Estimated: ~40 lines TypeScript, ~4 tests

- [ ] **Phase 25 — Sequential / Weight Sharing (Gap 8)**
  - [ ] Add `weight_sharing` to `SubflowConfig` in `tensortypes.ts`
  - [ ] Handle `weight_sharing` in `inferSubflow` — single instantiation
  - [ ] Add `ops/repeat_shared.py` — shared-weight repeat variant
  - [ ] Update `net/base.py` — handle shared-weight subflows
  - [ ] Add test: shared-weight Repeat → single parameter set
  - [ ] Estimated: ~200 lines TypeScript + Python, ~8 tests
