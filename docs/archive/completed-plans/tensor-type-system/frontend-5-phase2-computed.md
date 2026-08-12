# Task frontend-5 — Phase 2: Computed Dimensions + Shape-Preserving Modules

**Delegate to**: `@frontend`  
**Depends on**: Phase 1 complete (tensortypes, typeEngine, stereotype all exist)

---

## Objective

Extend the type system with:
1. A `computed` dimension kind for Conv2d/Flatten output size formulas
2. `type_signature` for 10 shape-preserving modules (trivial, `[*]→[*]`)
3. `type_signature` for Conv2d, MaxPool2d, AvgPool2d, Flatten

---

## Part A — Extend `tensortypes.ts`

Add a 5th variant to `ShapeDimPattern`:

```typescript
export type ShapeDimPattern =
  | { kind: 'const'; value: number }
  | { kind: 'symbolic'; name: string }
  | { kind: 'param_ref'; name: string }
  | { kind: 'wildcard' }
  | { kind: 'computed'; formula: string; args: string[] };  // NEW
```

Also export a `ShapeDimension` variant for resolved computed dims:

```typescript
export type ShapeDimension =
  | { kind: 'const'; value: number }
  | { kind: 'symbolic'; name: string }
  | { kind: 'param_ref'; name: string }
  | { kind: 'wildcard' }
  | { kind: 'computed'; formula: string; args: string[]; value?: number };
```

---

## Part B — Extend `typeEngine.ts`

### B1. Add a formula resolver

```typescript
/** Supported dimension formulas */
private static resolveFormula(formula: string, args: number[]): number | undefined {
  switch (formula) {
    case 'conv2d_hw': {
      // args: [H, kernel_size, stride, padding, dilation]
      // H_out = floor((H + 2*pad - dilation*(kernel-1) - 1) / stride + 1)
      const [h, k, s, p, d] = args;
      return Math.floor((h + 2*p - d*(k-1) - 1) / s + 1);
    }
    case 'pool2d_hw': {
      const [h, k, s, p] = args;
      return Math.floor((h + 2*p - k) / s + 1);
    }
    case 'flatten_prod': {
      // Product of all dims from start_dim to end_dim
      return args.reduce((a, b) => a * b, 1);
    }
    default:
      return undefined;
  }
}
```

### B2. Handle `computed` in `resolvePattern`

In `resolvePattern`, when encountering `{ kind: 'computed', formula, args }`:
1. Resolve each arg — look up in `env` for symbolic names, `params` for param_ref
2. If all args resolve to concrete numbers, compute the formula → `{ kind: 'const', value: N }`
3. If any arg is unresolved, emit `{ kind: 'computed', formula, args }` (symbolic, deferred)

### B3. Handle `computed` in `patternMatch`

In `patternMatch`, when a `computed` pattern dimension is encountered:
- Treat it like a constraint: resolve the formula, expect the input dim to match
- If formula can't be resolved (input H/W is symbolic), skip the exact check but record the constraint

For Phase 2, keep it simple: `computed` dims in the INPUT pattern just require the dimension to exist (don't validate the exact value — Conv2d doesn't constrain input H/W). `computed` dims in the OUTPUT pattern are resolved during `resolvePattern`.

---

## Part C — Add `type_signature` to 10 Shape-Preserving Modules

All identical to ReLU — `[*] → [*]`:

| File | Module |
|------|--------|
| `Stereotypes/Modules/Tanh.json` | Tanh |
| `Stereotypes/Modules/Sigmoid.json` | Sigmoid |
| `Stereotypes/Modules/Softmax.json` | Softmax |
| `Stereotypes/Modules/Dropout.json` | Dropout |
| `Stereotypes/Modules/BatchNorm1d.json` | BatchNorm1d |
| `Stereotypes/Modules/BatchNorm2d.json` | BatchNorm2d |
| `Stereotypes/Modules/LayerNorm.json` | LayerNorm |

For each, add:

```json
"type_signature": {
  "kind": "module",
  "input": [{ "kind": "wildcard" }],
  "output": [{ "kind": "wildcard" }]
}
```

Also add to `Stereotypes/Modules/Embedding.json` — Embedding takes `[B, seq_len]` and outputs `[B, seq_len, embedding_dim]`:

```json
"type_signature": {
  "kind": "module",
  "input": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$L" }
  ],
  "output": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$L" },
    { "kind": "param_ref", "name": "embedding_dim" }
  ]
}
```

---

## Part D — Conv2d, MaxPool2d, AvgPool2d

### Conv2d

```json
"type_signature": {
  "kind": "module",
  "input": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "param_ref", "name": "in_channels" },
    { "kind": "symbolic", "name": "$H" },
    { "kind": "symbolic", "name": "$W" }
  ],
  "output": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "param_ref", "name": "out_channels" },
    { "kind": "computed", "formula": "conv2d_hw", "args": ["$H", "kernel_size", "stride", "padding", "dilation"] },
    { "kind": "computed", "formula": "conv2d_hw", "args": ["$W", "kernel_size", "stride", "padding", "dilation"] }
  ]
}
```

### MaxPool2d / AvgPool2d — same pattern, different formula

```json
"type_signature": {
  "kind": "module",
  "input": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$C" },
    { "kind": "symbolic", "name": "$H" },
    { "kind": "symbolic", "name": "$W" }
  ],
  "output": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$C" },
    { "kind": "computed", "formula": "pool2d_hw", "args": ["$H", "kernel_size", "stride", "padding"] },
    { "kind": "computed", "formula": "pool2d_hw", "args": ["$W", "kernel_size", "stride", "padding"] }
  ]
}
```

### Flatten

```json
"type_signature": {
  "kind": "module",
  "input": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "wildcard" }
  ],
  "output": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "computed", "formula": "flatten_prod", "args": ["$*"] }
  ]
}
```

The `$*` arg means: "product of all wildcard-captured dimensions". The engine should compute the product of whatever dims were captured by the wildcard.

---

## Part E — Update `$` stripping for computed args

In `stereotype.ts` `parseTypeSignature()`, ensure computed args that start with `$` (like `$H`, `$W`, `$*`) are properly handled. `$*` is a special wildcard reference — strip the `$` for lookup.

---

## Part F — Tests

Add to `typeEngine.test.ts`:

1. **Conv2d shape inference**: Input(B,3,32,32) → Conv2d(in=3,out=16,k=3,s=1,p=1) → output should be (B,16,32,32)
2. **MaxPool2d**: 32x32 with k=2,s=2 → 16x16
3. **Flatten**: (B,128,7,7) → (B,6272)
4. **Shape-preserving chain**: Linear → Tanh → Sigmoid → Dropout — all preserve shape
5. **Embedding**: (B,50) → (B,50,256)

---

## Execution Order

1. Extend `tensortypes.ts` (Part A)
2. Extend `typeEngine.ts` (Part B)
3. Update stereotype JSONs (Parts C, D)
4. Update `stereotype.ts` parsing for computed args (Part E)
5. Add tests (Part F)
6. Run `npx vitest run` and `npm run check`
7. Commit: "feat: Phase 2 — computed dimensions, Conv2d/Flatten/Pool, 10 shape-preserving modules"
