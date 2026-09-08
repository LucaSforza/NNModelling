---
kind: knowledge
status: implemented
updated: 2026-09-07
---

# Arbitrary-rank MatMul

## Context

The core `MatMul` package previously accepted only rank-2 tensors, which made
batched matrix products such as attention scores impossible to represent in the
package type system even though the PyTorch runtime can evaluate them.

## Decision

`core.matmul` follows `torch.matmul` pair semantics for a left-to-right join:

- vectors and tensors with arbitrary batch rank are accepted, but scalar
  operands remain invalid;
- the final one or two dimensions are the matrix or vector dimensions;
- preceding dimensions broadcast from the right, with numeric dimension `1`
  as the broadcast dimension;
- equal symbolic dimensions are preserved, while different symbolic names are
  not unified implicitly;
- all operands in a join must have the same dtype.

The PyTorch entrypoint uses the same left-to-right semantics for non-matrix
inputs. The existing optimized matrix-chain path remains available when every
operand is rank 2.

## Consequences

For example, `[B, T, M] × [B, M, N]` produces `[B, T, N]`, and
`[2, 1, M, N] × [1, H, N, P]` broadcasts to `[2, H, M, P]`. The core
`Transpose` package swaps configurable dimensions (defaulting to the last two)
for `Q × Kᵀ`; arbitrary-rank `MatMul` support still does not infer that
transpose automatically.

The editor and backend now agree on vector, matrix, and batched shape
propagation. Broadcasting remains intentionally conservative for symbolic
dimensions because the frontend tensor contract does not perform symbolic
unification.
