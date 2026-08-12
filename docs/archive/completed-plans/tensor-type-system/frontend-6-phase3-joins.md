# Task frontend-6 — Phase 3: Join Type Checking

**Delegate to**: `@frontend`  
**Depends on**: Phase 1 + Phase 2 complete

---

## Objective

Add `type_signature` to all 6 join stereotypes and implement multi-input pattern matching in the engine.

---

## Part A — Join Type Signatures

### Addition

Element-wise addition: all inputs must have identical shapes.

```json
"type_signature": {
  "kind": "join",
  "input": [
    [{ "kind": "wildcard" }],
    [{ "kind": "wildcard" }]
  ],
  "output": [
    { "kind": "wildcard" }
  ]
}
```

**Constraint**: All input shapes must be equal. Implicit from using the same wildcard pattern for all inputs — the engine should bind captured dims from the first input and unify against subsequent inputs.

### Concat

Concatenates along a specified dimension. All other dims must match.

```json
"type_signature": {
  "kind": "join",
  "input": [
    [{ "kind": "wildcard" }],
    [{ "kind": "wildcard" }]
  ],
  "output": [
    { "kind": "wildcard" }
  ]
}
```

**Constraint**: All inputs have same shape except on `dim`. The output has same shape but `dim` is the sum of all input `dim`s.

For Phase 3, use a pragmatic approach: the `type_signature` declares wildcard patterns. The engine uses the first input's shape as the template, validates that subsequent inputs match on non-concat dims, and computes the concat dim sum.

**Implementation approach**: Add a `concat_dim` constraint to the signature:

```json
"type_signature": {
  "kind": "join",
  "input": [
    [{ "kind": "wildcard" }],
    [{ "kind": "wildcard" }]
  ],
  "output": [
    { "kind": "wildcard" }
  ],
  "constraints": {
    "concat": { "dim": "params.dim" }
  }
}
```

### MatMul

Matrix multiplication: `(M, K) × (K, N) → (M, N)`.

```json
"type_signature": {
  "kind": "join",
  "input": [
    [
      { "kind": "symbolic", "name": "$M" },
      { "kind": "symbolic", "name": "$K" }
    ],
    [
      { "kind": "symbolic", "name": "$K" },
      { "kind": "symbolic", "name": "$N" }
    ]
  ],
  "output": [
    { "kind": "symbolic", "name": "$M" },
    { "kind": "symbolic", "name": "$N" }
  ]
}
```

**Constraint**: K (second dim of first input) must equal K (first dim of second input). Symbolic unification handles this automatically — `$K` is bound from first input and verified against second.

### ScaledDotProduct + MaskedScaledDotProduct

Q: `(B, H, L, d_k)`, K: `(B, H, S, d_k)`, V: `(B, H, S, d_v)` → `(B, H, L, d_v)`.

```json
"type_signature": {
  "kind": "join",
  "input": [
    [
      { "kind": "symbolic", "name": "$B" },
      { "kind": "symbolic", "name": "$H" },
      { "kind": "symbolic", "name": "$L" },
      { "kind": "symbolic", "name": "$D" }
    ],
    [
      { "kind": "symbolic", "name": "$B" },
      { "kind": "symbolic", "name": "$H" },
      { "kind": "symbolic", "name": "$S" },
      { "kind": "symbolic", "name": "$D" }
    ],
    [
      { "kind": "symbolic", "name": "$B" },
      { "kind": "symbolic", "name": "$H" },
      { "kind": "symbolic", "name": "$S" },
      { "kind": "symbolic", "name": "$D_out" }
    ]
  ],
  "output": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$H" },
    { "kind": "symbolic", "name": "$L" },
    { "kind": "symbolic", "name": "$D_out" }
  ]
}
```

### Einsum

TODO — too complex for Phase 3. Keep `kind: "join"` with no type_signature (warning, unknown type).

---

## Part B — Engine Changes

### B1. Extend `TypeSignature`

Add optional constraints:

```typescript
export interface TypeSignature {
  kind: 'module' | 'join' | 'subflow';
  input: ShapePattern | ShapePattern[];
  output: ShapePattern;
  dtype?: { input?: DType; output?: DType };
  constraints?: {
    concat?: { dim: string };  // "params.dim" → resolves to dim number
  };
}
```

### B2. Handle `kind === 'join'` in `inferNode`

Replace the current TODO stub with real logic:

```
case "join": {
  const inputPatterns = sig.input as ShapePattern[];
  const inputTensorTypes = ...; // provided by caller

  if (!inputTensorTypes || inputTensorTypes.length === 0) {
    return { nodeId: "", message: "Join node has no inputs", severity: "error" };
  }

  // Step 1: Match each input pattern against corresponding input type
  const allCaptured: ShapeDimension[][] = [];
  const allBindings: TypeEnvironment[] = [];
  
  for (let k = 0; k < inputPatterns.length; k++) {
    const pat = inputPatterns[k];
    const inp = inputTensorTypes[k];
    if (!inp) continue;
    const match = patternMatch(inp.shape, pat, params, env);
    if (!match.success) return match;
    allCaptured.push(match.captured);
    allBindings.push(match.bindings);
  }

  // Step 2: Merge bindings (symbolic unification across inputs)
  const mergedEnv = new Map(env);
  for (const b of allBindings) {
    for (const [name, dim] of b) {
      if (!mergedEnv.has(name)) {
        mergedEnv.set(name, dim);
      }
    }
  }

  // Step 3: Compute output shape
  if (sig.constraints?.concat) {
    // Concat join: sum dims on the concat axis
    const concatDim = resolveConcatDim(sig.constraints.concat.dim, params);
    // ... compute concat output
  } else {
    // Standard: resolve output pattern with merged env
    const allCapturedFlat = allCaptured.flat();
    const outputDims = resolvePattern(sig.output, params, mergedEnv, allCapturedFlat);
    return { shape: outputDims, dtype: inputTensorTypes[0].dtype };
  }
}
```

### B3. Concat handling

For Concat, implement: take the first input's shape as template. For each subsequent input, verify all dims match except `concatDim`. On `concatDim`, sum all values.

```typescript
private static resolveConcatOutput(
  inputTypes: TensorType[],
  concatDim: number
): TensorShape {
  const shape = inputTypes[0].shape.map(d => ({...d}));
  let total = 0;
  for (const inp of inputTypes) {
    const dim = inp.shape[concatDim];
    if (dim.kind === 'const') total += dim.value;
    else return shape; // symbolic — can't compute
  }
  shape[concatDim] = { kind: 'const', value: total };
  return shape;
}
```

---

## Part C — Update `type_signature` JSONs

Add to: `Addition.json`, `Concat.json`, `MatMul.json`, `Einsum.json` (placeholder), `ScaledDotProduct.json`, `MaskedScaledDotProduct.json`.

---

## Part D — Tests

1. **Addition**: two `(B,256)` inputs → output `(B,256)`
2. **Addition mismatch**: `(B,256)` + `(B,128)` → error
3. **Concat**: `(B,128)` + `(B,64)` on dim=1 → `(B,192)`
4. **MatMul**: `(32,64)` × `(64,128)` → `(32,128)`
5. **MatMul mismatch**: `(32,64)` × `(128,64)` → error (K=64 ≠ 128)
6. **ScaledDotProduct**: Q(B,H,L,64) × K(B,H,S,64) × V(B,H,S,128) → (B,H,L,128)

---

## Execution Order

1. Extend `TypeSignature` in `tensortypes.ts`
2. Implement join matching in `typeEngine.ts`
3. Update 6 join stereotype JSONs
4. Add tests
5. `npx vitest run` + `npm run check`
6. Commit: "feat: Phase 3 — join type checking (Addition, Concat, MatMul, ScaledDotProduct)"
