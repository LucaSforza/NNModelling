# Variable Scoping: `$global` vs `#local`

## Problem

Symbolic variables in type signatures (e.g. `$D`, `$L`, `$H`) share a global
namespace via the `TypeEnvironment`. When two stereotypes reuse the same name
with different semantics, they collide:

```
PositionalEncoding: [B, L, D] → binds $D=128 (d_model)
ScaledDotProduct:   [B, L, D] → tries to bind $D=32 (proj_dim) → COLLISION
```

The root cause: `patternMatch` copies the entire global env and tries to unify
all previously-bound variables. There's no way to declare "this variable is
internal to my stereotype, don't inherit it from upstream."

## Solution

Two variable prefixes with different scoping semantics:

| Prefix | Scope | Behavior |
|--------|-------|----------|
| `$name` | **Global** | Propagates via env. Unifies across modules. Use for batch size, shared dimensions. |
| `#name` | **Local to stereotype** | Does NOT read from env. Does NOT write to env. Unifies only within a single stereotype's inputs/outputs. |

### Semantics

**`$B` (global):**
- Looked up in env during pattern matching
- If already bound, unify (must be equal)
- If not bound, create new binding
- After match, binding is propagated to global env (for downstream modules)

**`#D` (local):**
- NOT looked up in env during pattern matching
- Always creates a fresh binding within the stereotype's scope
- Unifies across multiple inputs of the SAME stereotype (joins: Q's `#D` must equal K's `#D`)
- NOT propagated to global env — invisible to downstream modules
- If resolved to a const, the output shape carries the const value directly (e.g. `128` instead of `#D`)

### Example

```
PositionalEncoding type_signature:
  input:  [$B, #L, #D]    ← #L, #D are local
  output: [$B, #L, #D]
  #D→128 (resolved to const). Output shape: [$B, 128, 128].
  Only $B goes into env.

ScaledDotProduct type_signature:
  input:  [$B, #L, #D] × [$B, #S, #D]   ← #D is local, fresh each time
  #L→128, #S→128, #D→32 (fresh bindings, no collision with PosEnc's #D!)
  output: [$B, #L, #S]
  Output shape: [$B, 128, 128]. Only $B goes into env (but already there).
```

## Implementation

### Phase 1 — engine (`typeEngine.ts`)

1. **`patternMatch()`** — symbolic case (line ~1233):
   - If `p.name.startsWith("#")` → skip env lookup, always create fresh binding
   - If `p.name.startsWith("$")` → current behavior (lookup in env, unify)

2. **Env merge** (lines ~387, ~548):
   - Only propagate bindings where key starts with `$`

3. **Subflow env** (`inferSubflow`, line ~913):
   - No change needed — `localEnv = new Map(env)` only copies `$` bindings
     (because `#` bindings were never added to env)

### Phase 2 — stereotypes (all `*.json`)

Rename variables in all 36+ stereotype files:
- Keep `$B` as `$B` (batch size, truly global)
- All others: change `$X` → `#X`

Affected stereotypes (non-exhaustive):
- Linear: `$B` stays, rest become `#in_features`, `#out_features`
- PositionalEncoding: `$L`, `$D` → `#L`, `#D`
- Embedding: `$L` → `#L`
- ScaledDotProduct: `$L`, `$S`, `$D` → `#L`, `#S`, `#D`
- MatMul: `$M`, `$K`, `$N` → `#M`, `#K`, `#N`
- Conv2d, MaxPool2d, etc.
- All joins (Addition, Concat, Einsum)
- Complex modules (MultiheadAttention, Transformer, etc.)

### Phase 3 — tests

1. Update all existing type engine tests to use `#` prefix for local vars
2. Un-skip `transformer_classifier.json: zero type errors on load`
3. Add test: `#D` in stereotype A does not collide with `#D` in stereotype B
4. Add test: `$B` still unifies across modules

## Migration

All existing stereotype JSONs need `$` → `#` rename. This is a search-and-replace
with one exception: `$B` stays as `$B`.

Scriptable with:
```bash
# For each stereotype JSON, rename $X to #X except $B
sed -i 's/"\$\([^B]\)/"#\1/g' Stereotypes/**/*.json
```

(Manual review required — some stereotypes like BatchNorm1d reference `$B` as
the only symbolic dim, which is correct.)
