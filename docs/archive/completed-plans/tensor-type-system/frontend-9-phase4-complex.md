# Task frontend-9 — Phase 4: Complex Module Type Signatures

**Delegate to**: `@frontend`
**Depends on**: Phase 1 + Phase 2 + Phase 3 complete (can run in parallel with frontend-8)

---

## Objective

Add `type_signature` to the 7 complex modules that currently emit `"No type signature"` warnings, plus 4 loss nodes and Fork. This provides full type coverage for all 35 stereotypes.

---

## Part A — Module Type Signatures

### A1. MultiheadAttention

PyTorch's `nn.MultiheadAttention` forward signature (batch_first=False by default):
```
Q: (L, B, embed_dim)
K: (L, B, kdim)  — defaults to embed_dim if kdim is None
V: (L, B, vdim)  — defaults to embed_dim if vdim is None
→ (L, B, embed_dim), attn_weights
```

However, NNModelling's MultiheadAttention is a single-input module (1 handle in, 1 handle out). It performs self-attention: Q=K=V from the same input. So the type is:

```
Input:  [B, L, embed_dim]  (assuming batch_first context from upstream)
Output: [B, L, embed_dim]  (same shape, only attention applied)
```

```json
"type_signature": {
  "kind": "module",
  "input": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$L" },
    { "kind": "param_ref", "name": "embed_dim" }
  ],
  "output": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$L" },
    { "kind": "param_ref", "name": "embed_dim" }
  ]
}
```

**Constraint**: The last input dimension must equal `embed_dim`. Output preserves all dimensions.

### A2. TransformerEncoderLayer

Single Transformer encoder layer. Input/output shape:
```
Input:  [B, L, d_model]
Output: [B, L, d_model]
```

```json
"type_signature": {
  "kind": "module",
  "input": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$L" },
    { "kind": "param_ref", "name": "d_model" }
  ],
  "output": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$L" },
    { "kind": "param_ref", "name": "d_model" }
  ]
}
```

### A3. TransformerDecoderLayer

Same shape semantics as encoder layer:
```
Input:  [B, L, d_model]   (tgt)
Output: [B, L, d_model]
```

```json
"type_signature": {
  "kind": "module",
  "input": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$L" },
    { "kind": "param_ref", "name": "d_model" }
  ],
  "output": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$L" },
    { "kind": "param_ref", "name": "d_model" }
  ]
}
```

*Note: The decoder layer also takes a `memory` cross-attention input in PyTorch. In NNModelling's single-input-per-node model, the memory connection would be a separate edge to a Join node. For now, we model only the self-attention path.*

### A4. Transformer

Full Transformer module (stack of encoder+decoder or encoder-only). Shape:
```
Input:  [B, L, d_model]  (src)
Output: [B, L, d_model]
```

```json
"type_signature": {
  "kind": "module",
  "input": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$L" },
    { "kind": "param_ref", "name": "d_model" }
  ],
  "output": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$L" },
    { "kind": "param_ref", "name": "d_model" }
  ]
}
```

### A5. PositionalEncoding

Adds sinusoidal positional encoding to the input. Shape-preserving — just adds values, doesn't change shape:

```
Input:  [B, L, d_model]
Output: [B, L, d_model]
```

```json
"type_signature": {
  "kind": "module",
  "input": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$L" },
    { "kind": "symbolic", "name": "$D" }
  ],
  "output": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$L" },
    { "kind": "symbolic", "name": "$D" }
  ]
}
```

**Design choice**: Use symbolic `$D` rather than `param_ref` to `d_model`. This makes PositionalEncoding accept any 3D input and propagate it, which is more flexible and matches the actual op behavior (it uses `x.size(-1)` at runtime).

### A6. SequencePool

Collapses the sequence dimension by taking the mean. Reduces rank by 1:

```
Input:  [B, L, D]
Output: [B, D]
```

```json
"type_signature": {
  "kind": "module",
  "input": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "wildcard" },
    { "kind": "symbolic", "name": "$D" }
  ],
  "output": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$D" }
  ]
}
```

The wildcard consumes the sequence dimension (and any additional dims). The output drops it entirely. `$D` is preserved.

### A7. Unsample

Upsamples the spatial dimensions by a scale factor. Like Conv2d/MaxPool2d, this needs **computed dimensions**:

```
Input:  [B, C, H, W]
Output: [B, C, H×scale, W×scale]  (if mode='nearest' with scale_factor)
```

For Phase 4, we can use a pragmatic approach — since Unsample has a `scale_factor` parameter, declare it with computed dims:

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
    { "kind": "computed", "formula": "upsample_hw", "args": ["$H", "scale_factor"] },
    { "kind": "computed", "formula": "upsample_hw", "args": ["$W", "scale_factor"] }
  ]
}
```

**Requires**: New formula `upsample_hw` in `typeEngine.ts`:
```typescript
case "upsample_hw": {
  const [h, scale] = args;
  return h * scale;
}
```

If `scale_factor` is `None`/`Undefined`, the computed dim remains unresolved (kept as deferred computed dim).

---

## Part B — Loss Nodes

Loss nodes are terminal (0 output handles). Their `type_signature` only needs to validate the input shape.

All loss functions accept `(predictions, targets)` but in NNModelling's single-input model:
- The loss node receives the model's output tensor
- Ground truth labels come from the dataset, not the graph

So the signature is simply:
```
Input:  [B, *]   (accept any shape)
Output: []       (no output — terminal node)
```

### BCELoss, BCEWithLogitsLoss, MSELoss

```json
"type_signature": {
  "kind": "module",
  "input": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "wildcard" }
  ],
  "output": []
}
```

**Dtype**: The output is implicitly `float32` (a scalar loss value), but since there's no output handle, the output shape is empty.

### CrossEntropyLoss

Standard cross-entropy for classification. Input must be `[B, C]` where `C` = number of classes. The `num_classes` parameter is indicated by the user at conversion time, not in the stereotype. So we use a generic pattern:

```json
"type_signature": {
  "kind": "module",
  "input": [
    { "kind": "symbolic", "name": "$B" },
    { "kind": "symbolic", "name": "$C" }
  ],
  "output": []
}
```

### Loss Node Engine Handling

When `output: []` (empty array), the engine returns `{ shape: [], dtype: "float32" }`. Downstream nodes won't connect because loss nodes have no output handle. The `dtype.output` field in the signature sets the output dtype explicitly for loss nodes (since there's no input dtype to propagate).

---

## Part C — Fork (Pass-Through)

Fork is an explicit passthrough. Currently has no `type_signature` → emits warning. Add one:

```json
"type_signature": {
  "kind": "module",
  "input": [{ "kind": "wildcard" }],
  "output": [{ "kind": "wildcard" }]
}
```

Identical to ReLU's signature — shape-preserving, dtype-preserving.

---

## Part D — New Formula: `upsample_hw`

In `typeEngine.ts`, add a case to `resolveFormula()`:

```typescript
case "upsample_hw": {
  const [h, scale] = args;
  return h * scale;
}
```

---

## Part E — Files to Modify

| File | Change |
|------|--------|
| `Stereotypes/Modules/MultiheadAttention.json` | Add `type_signature` |
| `Stereotypes/Modules/Transformer.json` | Add `type_signature` |
| `Stereotypes/Modules/TransformerEncoderLayer.json` | Add `type_signature` |
| `Stereotypes/Modules/TransformerDecoderLayer.json` | Add `type_signature` |
| `Stereotypes/Modules/PositionalEncoding.json` | Add `type_signature` |
| `Stereotypes/Modules/SequencePool.json` | Add `type_signature` |
| `Stereotypes/Modules/Unsample.json` | Add `type_signature` |
| `Stereotypes/Modules/BCELoss.json` | Add `type_signature` |
| `Stereotypes/Modules/BCEWithLogitsLoss.json` | Add `type_signature` |
| `Stereotypes/Modules/CrossEntropyLoss.json` | Add `type_signature` |
| `Stereotypes/Modules/MSELoss.json` | Add `type_signature` |
| `Stereotypes/Modules/Fork.json` | Add `type_signature` |
| `front-end/src/conversion/typeEngine.ts` | Add `upsample_hw` formula; ensure `output: []` works |
| `front-end/src/__tests__/typeEngine.test.ts` | Add Group 9 tests |

---

## Part F — Test Plan (Group 9)

### F1. Loss nodes: no type errors on valid connection
```
Test: Linear(784→10) → CrossEntropyLoss
  Setup: Input(784) → Linear(in_features=784, out_features=10) → CrossEntropyLoss
  Assert:
    - TypeResult.ok === true
    - CrossEntropyLoss has no output shape (or empty)
    - No errors
```

### F2. Loss nodes: wrong shape → error
```
Test: Linear(784→10) → BCELoss  [BCELoss expects [B] or [B, 1], not [B, 10]]
  Setup: Input(784) → Linear(in_features=784, out_features=10) → BCELoss
  Assert:
    - Warning only (BCELoss has wildcard — accepts any shape)
    - Note: strict BCELoss shape checking would require the sigmoid-binary distinction,
      not in scope for Phase 4
```

### F3. Fork: shape-preserving pass-through
```
Test: Input(784) → Fork
  Setup: Input(out_features=784) → Fork
  Assert:
    - TypeResult.ok === true
    - No warnings about missing type_signature for Fork
    - Fork output type = [B, 784]
```

### F4. PositionalEncoding: 3D shape preserved
```
Test: Embedding(1000, 256) → PositionalEncoding
  Setup: Input(50) → Embedding(num_embeddings=1000, embedding_dim=256) → PositionalEncoding
  Assert:
    - TypeResult.ok === true
    - PositionalEncoding output = [B, 50, 256] (same as Embedding output)
```

### F5. SequencePool: rank reduction
```
Test: Embedding(1000, 256) → SequencePool
  Setup: Input(50) → Embedding(num_embeddings=1000, embedding_dim=256) → SequencePool
  Assert:
    - TypeResult.ok === true
    - SequencePool output = [B, 256] (L dim collapsed)
```

### F6. MultiheadAttention: 3D shape preserved
```
Test: Embedding(1000, 512) → MultiheadAttention(embed_dim=512)
  Setup: Input(50) → Embedding(num_embeddings=1000, embedding_dim=512) → MHA(embed_dim=512)
  Assert:
    - TypeResult.ok === true
    - MHA output = [B, 50, 512]
```

### F7. MultiheadAttention: embed_dim mismatch → error
```
Test: Embedding(1000, 256) → MultiheadAttention(embed_dim=512)  [MISMATCH]
  Setup: 256 ≠ 512 → error
  Assert:
    - Error: dimension mismatch, embed_dim=512 vs 256
```

### F8. Unsample: computed dim via upsample_hw formula
```
Test: resolveFormula("upsample_hw", [32, 2])
  Assert: 64
Test: resolveFormula("upsample_hw", [16, 1])
  Assert: 16
```

### F9. Loss node: empty output shape
```
Test: CrossEntropyLoss output has empty shape
  Assert: outputType.shape === []
```

---

## Execution Order

1. Add `upsample_hw` formula to `typeEngine.ts`
2. Verify `output: []` works (empty output pattern → empty shape)
3. Add `type_signature` to all 13 stereotype JSONs (A1-A7, B1-B4, C)
4. Add Group 9 tests
5. `npx vitest run` + `npm run check`
6. Commit: "feat: Phase 4 — complex module type signatures (MHA, Transformer, PosEnc, SeqPool, Unsample, Loss, Fork)"
