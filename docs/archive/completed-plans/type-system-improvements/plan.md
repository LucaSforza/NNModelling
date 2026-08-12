# Type System Improvements — Plan

> **Archive note (2026-08-12):** the original design status below is retained
> for history. The documented improvements are implemented; use
> [`docs/knowledge/contracts/tensor-types.md`](../../../knowledge/contracts/tensor-types.md)
> for the current contract.

**Original status**: Design
**Date**: 2026-07-15
**Based on**: review of `docs/archive/reports/report/type-system-gaps.md`

---

## What We're Fixing (and What We're Not)

Of the 8 gaps identified, 4 are real and actionable. 4 are not:

| Gap | Verdict | Action |
|-----|---------|--------|
| 1. Batch unification | ❌ Already works. `TypeEnvironment` is shared across all nodes; `patternMatch` unifies against it. | **Skip** |
| 2. Dtype propagation | ⚠️ Output propagation works (Input.json already declares `dtype.output: "float32"`). Missing: input-side validation. | **Fix** (narrow scope) |
| 3. Einsum | ✅ Real gap. No type_signature at all. Fixed with label-mapping parser (~120 lines), not the 300-line module + new pattern kind originally proposed. | **Fix** |
| 4. Reasonable shapes | ✅ Real, well-analyzed. Expression-based advisories. | **Fix** |
| 5. Dynamic shapes | ❌ Different symbolic names already handle this (`$L` vs `$L_reduced`). `class: variable` adds no new capability. | **Skip** |
| 6. Shape suggestions | ✅ Real, well-analyzed. Low effort, high UX value. | **Fix** |
| 7. MatMul ordering | ⚠️ Not a correctness gap. Error message improvement only. | **Fix** (trivial) |
| 8. Weight sharing | ❌ Python backend feature, not a type system concern. | **Skip** |

---

## Implementation Plan — 4 Phases

### Phase A — Dtype Input Validation (Gap 2, narrowed)

**What**: Check that incoming tensor dtype matches what the module declares as acceptable input.

**Why only warnings, not errors**: PyTorch is forgiving about dtype (autocast, implicit conversions). NNModelling diagrams are 99% float32 throughout. Embedding technically expects int64 but works with float32 in practice. Being strict would create noise without catching real bugs. Warnings surface genuine gotchas without blocking compilation.

**Changes**:

1. **`tensortypes.ts`** — `TypeSignature.dtype` already has `input`/`output` fields. No change needed.

2. **`typeEngine.ts`**, `inferNode` (module case, ~line 345) — After `patternMatch` succeeds and before `resolvePattern`, add:
   ```
   // Validate input dtype against declared contract
   if (sig.dtype?.input && inputType.dtype !== sig.dtype.input) {
       // Warning, not error — PyTorch handles most conversions
   }
   ```
   The warning is pushed to a `warnings` collection (introduced in Phase B).

3. **Stereotype JSONs** — Add `dtype.input` and `dtype.output` to 7 stereotypes:

   | Stereotype | `dtype.input` | `dtype.output` | Why |
   |-----------|--------------|----------------|-----|
   | `Embedding.json` | `"int64"` | `"float32"` | Token indices are int64 |
   | `BatchNorm1d.json` | `"float32"` | `"float32"` | Normalization needs float |
   | `BatchNorm2d.json` | `"float32"` | `"float32"` | Same |
   | `LayerNorm.json` | `"float32"` | `"float32"` | Same |
   | `CrossEntropyLoss.json` | `"float32"` | — | Logits must be float |
   | `Softmax.json` | `"float32"` | `"float32"` | Softmax on float |
   | `Dropout.json` | `"float32"` | `"float32"` | Dropout on float |

   Note: `Input.json` already has `dtype.output: "float32"`. No change needed.

4. **`typeEngine.test.ts`** — Test cases:
   - Float32 chain → no warning (happy path)
   - Input(float32) → Embedding → warning "Embedding expects int64 input, got float32"
   - BatchNorm with float32 input → no warning

**Estimated**: ~40 lines TypeScript, ~5 tests

---

### Phase B — Reasonable Shape Advisories (Gap 4) + Warnings Infrastructure

**What**: Advisory warnings for configurations that are technically valid but likely mistakes.

**Infrastructure needed**: `TypeWarning` interface and `warnings` array in `TypeResult` (shared with Phase A).

**Changes**:

1. **`tensortypes.ts`** — Add:
   ```typescript
   export interface TypeWarning {
     nodeId: string;
     message: string;
     kind: 'dtype' | 'shape' | 'perf' | 'style';
   }
   ```
   Add `warnings: TypeWarning[]` to `TypeResult`.

2. **`tensortypes.ts`** — Add `Advisory` interface:
   ```typescript
   export interface Advisory {
     /** Expression condition — if truthy, warning fires */
     condition: string;
     message: string;
     kind: 'perf' | 'style';
   }
   ```
   Add optional `advisories?: Advisory[]` to `TypeSignature`.

3. **`typeEngine.ts`**, `inferNode` (module case) — After output type is computed, evaluate each advisory's `condition` expression with the bound environment. If truthy, push warning.

4. **Stereotype JSONs** — Add advisories to 4 stereotypes:

   **`Conv2d.json`**:
   ```json
   "advisories": [{
     "condition": "kernel_size > $H || kernel_size > $W",
     "message": "kernel_size exceeds one or both input spatial dimensions",
     "kind": "perf"
   }]
   ```

   **`Dropout.json`**:
   ```json
   "advisories": [{
     "condition": "p > 0.5",
     "message": "Dropout rate > 0.5: more than half of activations are dropped",
     "kind": "perf"
   }]
   ```

   **`Conv1d.json`** — same spatial check as Conv2d, adapted for 1D.

   **`MaxPool2d.json`** — kernel_size > input spatial dims check.

   Advisory for redundant Flatten→Flatten is a *graph-level* check, not a single-node advisory. Deferred to a possible Phase E (graph-level linting).

   Advisory for extreme Linear compression ratio (in_features / out_features > 100) — also deferred; requires env access to both in_features and out_features simultaneously, which is more complex.

5. **`typeEngine.test.ts`** — Test cases:
   - Conv2d(3×3) on (1, 28, 28) → no warning
   - Conv2d(32×32) on (1, 16, 16) → warning
   - Dropout(p=0.2) → no warning
   - Dropout(p=0.8) → warning

6. **`typeEngine.ts`**, `infer()` — Collect warnings from `inferNode` results, merge into final `TypeResult.warnings`.

**Estimated**: ~100 lines TypeScript, ~8 tests

---

### Phase C — Shape Suggestions (Gap 6)

**What**: When a parameter is unset, suggest a concrete value from the incoming tensor shape.

**Changes**:

1. **`tensortypes.ts`** — Add:
   ```typescript
   export interface TypeSuggestion {
     nodeId: string;
     param: string;
     value: number;
     reason: string;
   }
   ```
   Add `suggestions: TypeSuggestion[]` to `TypeResult`.

2. **`typeEngine.ts`**, `inferNode` (module case) — After `patternMatch` succeeds, walk the pattern and input shape in parallel. For each `param_ref` pattern element at position `j` whose resolution is `"unset"`:
   - Look at `inputType.shape[j]`
   - If it's a `const` dimension, generate a suggestion
   
   ```
   // In patternMatch, when param_ref resolves as unset:
   const inputDim = inputDims[i];
   if (inputDim.kind === 'const') {
       // Report: param p.name could be inputDim.value
   }
   ```
   
   We do NOT modify `patternMatch` — it has no access to the suggestions array. Instead, add a separate post-match pass in `inferNode` that correlates pattern positions with input dims and checks which param_refs remain unset.

   Wait — simpler approach: `patternMatch` already handles unset params at line 1131. It pushes `{ kind: 'symbolic', name: '?in_features' }` to `captured`. But the `?` prefix means we can trace it. Hmm, but `captured` is for wildcard dims, not param_refs.

   Actually: the unset param_ref case in `patternMatch` (line 1132) pushes to `captured` — but that's mixing purposes. Let me re-read...

   ```typescript
   case "param_ref": {
     const resolved = this.resolveParamRef(p.name, params);
     if (resolved.status === 'unset') {
       captured.push({ kind: "symbolic", name: `?${p.name}` });
       i++;
       j++;
     }
   ```

   So unset params end up in `captured` as symbolic `?param_name`. Then in `resolvePattern`, when a `param_ref` appears in the output pattern and is unset, it becomes `{ kind: 'symbolic', name: '?param_name' }`. The `?` prefix is the convention for "unknown param."

   For suggestions: during `inferNode` (after `patternMatch`), re-walk the input pattern and input shape. For each `param_ref` at position `j`, if `resolveParamRef` returns `"unset"` and `inputType.shape[j].kind === 'const'`, emit a suggestion.

   Actually, an even simpler approach: modify `patternMatch` to return `suggestions` alongside `bindings` and `captured`. Or better: add a `suggestions` parameter to `patternMatch` (an array to push into).

   Let me think about the simplest change...

   **Simplest approach**: modify `patternMatch` to accept an optional `suggestions` out-parameter array. When `param_ref` resolves as `"unset"`, if the corresponding input dim is `const`, push a suggestion.

3. **`typeEngine.ts`**, `patternMatch` — Add optional 5th parameter `suggestions?: TypeSuggestion[]`. In the `param_ref` unset case:
   ```typescript
   if (resolved.status === 'unset') {
       captured.push({ kind: "symbolic", name: `?${p.name}` });
       if (suggestions && i < inputDims.length && inputDims[i].kind === 'const') {
           suggestions.push({
               nodeId: '', // filled by caller
               param: p.name,
               value: inputDims[i].value,
               reason: `matches input dimension at position ${j}`
           });
       }
       i++;
       j++;
   }
   ```

4. **`typeEngine.ts`**, `inferNode` — Pass `suggestions` array to `patternMatch`. After match, set `nodeId` on each suggestion.

5. **`typeEngine.ts`**, `infer()` — Collect suggestions from `inferNode`, merge into `TypeResult.suggestions`.

6. **`typeEngine.test.ts`** — Test cases:
   - Linear after Input(784) → suggest `in_features=784`
   - Conv2d after Input(1, 28, 28) → suggest `in_channels=1`
   - Parameter already set → no suggestion

7. **UI integration** (deferred) — The suggestions are available in `TypeResult`. Actual UI rendering in `Sidebar.svelte` is a separate frontend task beyond this plan.

**Estimated**: ~60 lines TypeScript, ~6 tests

---

### Phase D — Better Join Error Messages (Gap 7)

**What**: Add human-readable labels to join input patterns for clearer error messages.

**Changes**:

1. **`tensortypes.ts`** — Add optional `input_labels?: string[]` to `JoinConfig`.

2. **`typeEngine.ts`**, join handling (~line 390) — When reporting "Input N mismatch", use the label if available:
   ```
   const label = sig.join?.input_labels?.[k] ?? `Input ${k}`;
   message: `${label} mismatch: ${matchResult.message}`
   ```

3. **Stereotype JSONs** — Add labels:
   - `MatMul.json`: `"input_labels": ["A", "B"]`
   - `ScaledDotProduct.json`: `"input_labels": ["Q", "K", "V"]`
   - `MaskedScaledDotProduct.json`: `"input_labels": ["Q", "K", "V", "mask"]`

**Estimated**: ~20 lines TypeScript, ~2 tests

---

### Phase E — Einsum Shape Inference (Gap 3, redesigned)

**What**: Parses the Einstein notation expression (`"ij,jk->ik"`) to validate arity, check rank compatibility, and compute the correct output shape. No new module, no new pattern kind — a single `inferEinsumShape` method on `TypeEngine`, activated by `JoinConfig.action: "einsum"`.

#### Design

##### Parser spec

The parser handles three things:

1. **Split equation into input label groups and output labels**
2. **Validate each input's label count matches its tensor rank**
3. **Map output labels to source dimensions from input tensors**

```
Equation:  "ij, jk -> ik"   or   "ij,jk" (implicit output)
           ├─────┘  ├─┘
           inputs   output
```

##### Algorithm — `inferEinsumShape(equation, inputTypes)`

**Step 1 — Parse equation string**

```
let lhs: string, rhs: string | undefined
if equation contains "->":
    split on "->" → [lhs, rhs]
    rhs = rhs.trim()
else:
    lhs = equation
    rhs = undefined  // output will be computed implicitly

inputLabels = lhs.split(",").map(s => s.trim())
// e.g. "ij,jk" → [["i","j"], ["j","k"]]
```

**Step 2 — Validate arity and ranks**

```
if inputLabels.length !== inputTypes.length:
    → error: "equation expects N inputs, got M"

for each (labelStr, tensor) in zip(inputLabels, inputTypes):
    if labelStr.length !== tensor.shape.length:
        → error: "label group 'ij' has 2 dims but input has N dims"
```

**Step 3 — Determine output labels**

Two modes:

- **Explicit output** (`rhs` defined): output labels are the characters of `rhs`. Empty `rhs` → scalar `[]`.
- **Implicit output** (`rhs` undefined): labels that appear exactly once across all input label groups, sorted alphabetically.

```
implicit_output_labels:
    count occurrences of each label across all input groups
    labels with count === 1 → output, sorted alphabetically
    labels with count > 1  → contracted (not in output)
```

Examples of implicit output:
- `"ij,jk"` → `i`(count 1), `j`(count 2), `k`(count 1) → output `"ik"`
- `"x,y"` → `x`(count 1), `y`(count 1) → output `"xy"` (alphabetically)
- `"ii"` → `i`(count 2) → output `""` (scalar, trace)

**Step 4 — Map output labels to dimensions**

For each output label:
```
found = []
for each input k with label string inputLabels[k]:
    for each position p where inputLabels[k][p] == outputLabel:
        found.push(inputTypes[k].shape[p])

if found.length === 0:
    → error: "label 'X' in output not found in any input"
if found.length >= 2:
    // unify: all found dims must be equal
    for each pair in found:
        if !dimEqual(pair[0], pair[1]):
            → error: "label 'X' bound to conflicting dims"
outputDims.push(found[0])
```

**Step 5 — Return output shape**

```
return {
    shape: outputDims,
    dtype: inputTypes[0].dtype  // propagate from first input
}
```

##### Ellipsis `...` — explicitly unsupported

If the equation contains `...` → error: `"ellipsis not supported in type inference"`.

Rationale: `...` requires computing how many dims it consumes per input (rank - explicit_labels), unifying those counts, and reproducing them in output — significant complexity for a pattern that essentially never appears in deep learning einsum usage.

##### Integration — data-driven, no name checks

**`JoinConfig`** gets two new fields:

```typescript
export interface JoinConfig {
    action?: 'element_wise' | 'concat' | 'matmul' | 'einsum';
    dim_expr?: string;
    input_labels?: string[];
    /** For einsum joins: name of the param holding the equation (default "expr") */
    einsum_param?: string;
}
```

**`Einsum.json`** stereotype:

```json
{
    "category": "Join",
    "pythonClassName": "ops.Einsum",
    "params": {
        "expr": { "type": "string", "default": "" }
    },
    "type_signature": {
        "kind": "join",
        "input": [
            [{ "kind": "wildcard" }],
            [{ "kind": "wildcard" }]
        ],
        "output": [{ "kind": "wildcard" }],
        "join": {
            "action": "einsum",
            "einsum_param": "expr"
        }
    }
}
```

**Engine integration** — in `inferNode`, join case, before pattern matching:

```typescript
if (sig.join?.action === 'einsum') {
    const paramName = sig.join.einsum_param ?? 'expr';
    const equation = extractParamString(params, paramName);
    if (!equation || equation.length === 0) {
        return { message: "Einsum expression is empty", severity: "error" };
    }
    const outputShape = this.inferEinsumShape(equation, inputTypes, stereotype.name);
    if (isTypeError(outputShape)) return outputShape;
    return { shape: outputShape, dtype: inputTypes[0].dtype };
}
```

The existing wildcard-based `type_signature` input/output is a fallback — if the einsum handler short-circuits with a computed shape, pattern matching never runs. If `action` is missing or the equation is empty, the wildcard patterns serve as graceful degradation.

##### Test cases

| Test | Equation | Input shapes | Expected output |
|------|----------|-------------|-----------------|
| Basic matmul | `"ij,jk->ik"` | `[M,K]`, `[K,N]` | `[M,N]` |
| Batched matmul | `"bij,bjk->bik"` | `[B,M,K]`, `[B,K,N]` | `[B,M,N]` |
| Contraction | `"x,y->x"` | `[M]`, `[K]` | `[M]` |
| Trace | `"ii->"` | `[N,N]` | `[]` |
| Diagonal | `"ii->i"` | `[N,N]` | `[N]` |
| Implicit output | `"ij,jk"` | `[M,K]`, `[K,N]` | `[M,N]` |
| Implicit scalar | `"ii"` | `[N,N]` | `[]` |
| 3-input chain | `"ij,jk,kl->il"` | `[M,K]`, `[K,L]`, `[L,P]` | `[M,P]` |
| Arity mismatch | `"ij,jk->ik"`, 3 inputs | — | error |
| Rank mismatch | `"ij,jk->ik"` | `[M,K]`, `[K]` | error |
| Label not in input | `"x->y"` | `[M]` | error |
| Empty equation | `""` | `[M]`, `[K]` | error |
| Ellipsis | `"b...ij,b...jk->b...ik"` | — | error "ellipsis not supported" |
| Conflicting dims | `"ij,ij->i"` | `[M,K]`, `[N,K]` | error (M≠N for label i) |

**Estimated**: ~120 lines TypeScript, ~14 tests

---

## Overall Scope

| Phase | What | Lines | Tests |
|-------|------|-------|-------|
| A | Dtype input validation | ~40 TS | ~5 |
| B | Reasonable shape advisories + warnings infra | ~100 TS | ~8 |
| C | Shape suggestions | ~60 TS | ~6 |
| D | Join input labels | ~20 TS | ~2 |
| E | Einsum shape inference | ~120 TS | ~14 |
| **Total** | | **~340 TS** | **~35** |

Compare with the original document's estimate: ~1090 lines + ~73 tests. This plan delivers more value at **~30% of the cost** by skipping fake gaps (Gaps 1, 5, 8), narrowing Gap 2 to input-side only, and replacing the overengineered Einsum solution with a tight ~120-line label-mapping parser.

---

## What's Explicitly Deferred

| Item | Reason |
|------|--------|
| Einsum with ellipsis (`...`) | Requires computing dim consumption via rank arithmetic, unifying consumed counts across inputs. Complex for a feature that's essentially unused in deep learning einsum. Explicit error message instead. |
| Redundant Flatten→Flatten advisory | Requires graph-level pattern matching, not single-node advisories. |
| Extreme Linear compression advisory | Requires simultaneous access to both `in_features` and `out_features` from env, complex. |
| `params.dtype` removal from Stereotypes | It's a codegen parameter, not a type system parameter. Stays as-is. |
| Weight sharing subflow | Python backend concern, not type system. |
| `global` flag on symbolic patterns | Cross-node unification already works via shared `TypeEnvironment`. |
| `class: variable` on symbolic patterns | Different symbolic names (`$L` vs `$L_reduced`) already handle variable-length sequences. |
| UI rendering of suggestions/advisories | Separate frontend task, not type engine. |

---

## Files to Modify

| Phase | Files |
|-------|-------|
| A | `typeEngine.ts`, `Embedding.json`, `BatchNorm1d.json`, `BatchNorm2d.json`, `LayerNorm.json`, `CrossEntropyLoss.json`, `Softmax.json`, `Dropout.json`, `typeEngine.test.ts` |
| B | `tensortypes.ts`, `typeEngine.ts`, `Conv2d.json`, `Conv1d.json`, `Dropout.json`, `MaxPool2d.json`, `typeEngine.test.ts` |
| C | `tensortypes.ts`, `typeEngine.ts`, `typeEngine.test.ts` |
| D | `tensortypes.ts`, `typeEngine.ts`, `MatMul.json`, `ScaledDotProduct.json`, `MaskedScaledDotProduct.json`, `typeEngine.test.ts` |
| E | `tensortypes.ts`, `typeEngine.ts`, `Einsum.json`, `typeEngine.test.ts` |
