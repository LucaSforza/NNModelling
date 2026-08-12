# Task frontend-1 — Type Model Interfaces

> Historical design note. The current type model also includes warnings,
> suggestions, and optional `NodeTypeAnnotation.blockedBy` provenance for
> suppressing diagnostics caused by an upstream type error. See
> `front-end/src/conversion/tensortypes.ts` and
> `docs2/source/type_system.rst` for the active contract.

**Delegate to**: `@frontend`  
**Depends on**: None (first task)  
**Estimated files**: 1 new file

---

## Objective

Create `front-end/src/conversion/tensortypes.ts` — the core type definitions for the tensor type system. This file contains **only interfaces and type aliases**, no runtime logic.

---

## Files to Create

| File | Action |
|------|--------|
| `front-end/src/conversion/tensortypes.ts` | CREATE |

## Files to Modify

None.

---

## Detailed Spec

### 1. `ShapeDimension` — discriminated union for a single dimension

```typescript
export type ShapeDimension =
  | { kind: 'const'; value: number }
  | { kind: 'symbolic'; name: string }
  | { kind: 'param_ref'; name: string }
  | { kind: 'wildcard' };
```

**Semantics**:

| kind | meaning | example |
|------|---------|---------|
| `'const'` | literal integer dimension | `{ kind: 'const', value: 784 }` |
| `'symbolic'` | named variable (e.g. batch size) | `{ kind: 'symbolic', name: 'B' }` |
| `'param_ref'` | references a node parameter | `{ kind: 'param_ref', name: 'in_features' }` |
| `'wildcard'` | matches zero or more arbitrary dims | `{ kind: 'wildcard' }` |

### 2. `TensorShape` — simple type alias

```typescript
export type TensorShape = ShapeDimension[];
```

### 3. `DType` — string-based dtype

```typescript
export type DType = string;
```

We use `string` instead of a union type (`'float32' | 'float64' | ...`) to remain extensible without changing this file. Common values: `'float32'`, `'float64'`, `'int64'`, `'int32'`, `'bool'`, `'unknown'`.

### 4. `TensorType` — full tensor type

```typescript
export interface TensorType {
  shape: TensorShape;
  dtype: DType;
}
```

### 5. `ShapeDimPattern` — what appears in stereotype JSON `type_signature`

This is the *declarative* form. JSON patterns use `$B` to distinguish symbolic dims from param refs; the `$` is stripped when loading into this canonical form.

```typescript
export type ShapeDimPattern =
  | { kind: 'const'; value: number }
  | { kind: 'symbolic'; name: string }    // $ stripped: "$B" → name: "B"
  | { kind: 'param_ref'; name: string }   // "params.in_features" → name: "in_features"
  | { kind: 'wildcard' };                 // "$..." or "*"
```

### 6. `ShapePattern` — sequence of dim patterns

```typescript
export type ShapePattern = ShapeDimPattern[];
```

### 7. `TypeSignature` — what stereotypes declare

```typescript
export interface TypeSignature {
  /** 'module' | 'join' | 'subflow' */
  kind: 'module' | 'join' | 'subflow';

  /** Input pattern(s). Single ShapePattern for modules, array for joins */
  input: ShapePattern | ShapePattern[];

  /** Output pattern */
  output: ShapePattern;

  /** Optional dtype constraints */
  dtype?: {
    input?: DType;
    output?: DType;
  };
}
```

### 8. `TypeError` — error reporting

```typescript
export interface TypeError {
  nodeId: string;
  message: string;
  severity: 'error' | 'warning';
}
```

### 9. `NodeTypeAnnotation` — per-node type info

```typescript
export interface NodeTypeAnnotation {
  nodeId: string;

  /** Type arriving at this node (undefined for Input/source nodes) */
  inputType?: TensorType;

  /** For join nodes: one type per input handle (in-0, in-1, ...) */
  inputTypes?: TensorType[];

  /** Type produced by this node */
  outputType: TensorType;
}
```

### 10. `TypeResult` — inference output

```typescript
export interface TypeResult {
  ok: boolean;
  annotations: Map<string, NodeTypeAnnotation>;
  errors: TypeError[];
}
```

### 11. `TypeEnvironment` — symbolic bindings

```typescript
export type TypeEnvironment = Map<string, ShapeDimension>;
```

---

## Implementation Notes

- **NO runtime logic**. This file is purely type definitions.
- **NO imports** from other project files (no dependency on Diagram, nnTree, stereotypes, etc.).
- Export everything so `typeEngine.ts` and tests can import.
- Use JSDoc comments on each export describing its purpose.
- The `ShapeDimPattern` type parallels `ShapeDimension` but represents *unresolved* patterns (may contain symbolic names not yet bound). They are separate because resolved dims use `ShapeDimension` and unresolved patterns use `ShapeDimPattern` — this distinction prevents accidentally treating a pattern as a resolved dimension.

---

## Test Plan

No tests for this file — it contains only types. TypeScript compilation (`npm run check`) verifies type correctness.
