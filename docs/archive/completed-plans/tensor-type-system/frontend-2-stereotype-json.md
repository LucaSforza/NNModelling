# Task frontend-2 — Stereotype Extension + JSON Updates

**Delegate to**: `@frontend`  
**Depends on**: `frontend-1` (tensortypes.ts must exist)  
**Estimated files**: 1 modified, 3 modified

---

## Objective

1. Extend `StereotypeJson` and `Stereotype` class to parse the new `type_signature` field from stereotype JSON files.
2. Add `type_signature` declarations to `Input.json`, `Linear.json`, and `ReLU.json`.

---

## Files to Modify

| File | Action |
|------|--------|
| `front-end/src/stereotype.ts` | Add `type_signature` to `StereotypeJson`, parse in `Stereotype` constructor |
| `Stereotypes/Modules/Input.json` | Add `type_signature` field |
| `Stereotypes/Modules/Linear.json` | Add `type_signature` field |
| `Stereotypes/Modules/ReLU.json` | Add `type_signature` field |

## Files to Create

None.

---

## Detailed Spec

### Part A — `stereotype.ts` changes

#### A1. Import the type

At the top of `stereotype.ts`, add:

```typescript
import type { TypeSignature } from './conversion/tensortypes';
```

#### A2. Extend `StereotypeJson`

Add an optional `type_signature` field:

```typescript
export interface StereotypeJson {
  category?: string;
  pythonClassName?: string;
  taskType?: "classification" | "regression";
  expr?: string;
  view?: Partial<StereotypeView>;
  params?: Record<string, ModuleParameter>;
  type_signature?: TypeSignature;   // <-- NEW
}
```

#### A3. Extend `Stereotype` class

Add a readonly property:

```typescript
export class Stereotype {
  // ... existing properties ...

  /** Optional type signature for static tensor type checking.
   *  undefined means this stereotype has not been annotated yet. */
  public readonly typeSignature: TypeSignature | undefined;

  constructor(filePath: string, data: StereotypeJson) {
    // ... existing initialization ...

    this.typeSignature = data.type_signature;
  }
}
```

**Important**: The property must be `undefined` (not null, not a default empty object) when absent, so the TypeEngine can distinguish "no signature" from "signature exists but is empty."

#### A4. No other changes

Do NOT change:
- `loadFromDirectory()` — `import.meta.glob` already returns the full JSON, the new field is automatically included
- `isJoin`, `isInput`, `isLoss`, `isSubFlow` predicates
- Parameter parsing
- View defaults

---

### Part B — `Input.json`

Add `type_signature` **after** the `params` block (before the closing `}`):

```json
{
  "category": "Input",
  "pythonClassName": "None",
  "view": {
    "color": "#27b376",
    "width": 25,
    "height": 15
  },
  "params": {
    "out_features": {
      "type": "int",
      "default": "784"
    }
  },
  "type_signature": {
    "kind": "module",
    "input": [],
    "output": [
      { "kind": "symbolic", "name": "$B" },
      { "kind": "param_ref", "name": "out_features" }
    ],
    "dtype": {
      "output": "float32"
    }
  }
}
```

**Semantics**:
- `input: []` — Input nodes are sources, no input tensor
- Output: `[B, out_features]` — batch dim is symbolic, last dim from parameter
- Output dtype: `float32`

### Part C — `Linear.json`

Add `type_signature` **after** the `params` block:

```json
{
  "category": "Layer",
  "pythonClassName": "nn.Linear",
  "expr": "",
  "view": {
    "color": "#4779c4",
    "width": 140,
    "height": 60
  },
  "params": {
    "in_features": {
      "type": "int",
      "default": "Undefined",
      "position": "top"
    },
    "out_features": {
      "type": "int",
      "default": "Undefined",
      "position": "bottom"
    },
    "bias": {
      "type": "bool",
      "default": "True"
    },
    "device": {
      "type": "str",
      "default": "None"
    },
    "dtype": {
      "type": "str",
      "default": "None"
    }
  },
  "type_signature": {
    "kind": "module",
    "input": [
      { "kind": "symbolic", "name": "$B" },
      { "kind": "wildcard" },
      { "kind": "param_ref", "name": "in_features" }
    ],
    "output": [
      { "kind": "symbolic", "name": "$B" },
      { "kind": "wildcard" },
      { "kind": "param_ref", "name": "out_features" }
    ]
  }
}
```

**Semantics**:
- Input: `[B, *, in_features]` — batch, arbitrary intermediate dims, last dim = in_features
- Output: `[B, *, out_features]` — same batch, same intermediate, last dim = out_features
- No dtype constraint → dtype propagates from input

### Part D — `ReLU.json`

Add `type_signature` **after** the `params` block:

```json
{
  "category": "Layer",
  "pythonClassName": "nn.ReLU",
  "expr": "",
  "view": {
    "color": "#f4a460",
    "width": 100,
    "height": 50
  },
  "params": {
    "inplace": {
      "type": "bool",
      "default": "False"
    }
  },
  "type_signature": {
    "kind": "module",
    "input": [
      { "kind": "wildcard" }
    ],
    "output": [
      { "kind": "wildcard" }
    ]
  }
}
```

**Semantics**:
- ReLU is shape-preserving: wildcard on input captures entire shape, wildcard on output reproduces it
- Dtype propagates from input (no explicit dtype constraint)

---

## Key Rules for JSON `type_signature`

| JSON value | Canonical `ShapeDimPattern` | Notes |
|-----------|---------------------------|-------|
| `{ "kind": "const", "value": 3 }` | `{ kind: 'const', value: 3 }` | Literal dimension |
| `{ "kind": "symbolic", "name": "$B" }` | `{ kind: 'symbolic', name: 'B' }` | `$` prefix distinguishes from param_ref during JSON authoring; `$` is **stripped** when parsing into `ShapeDimPattern` |
| `{ "kind": "param_ref", "name": "in_features" }` | `{ kind: 'param_ref', name: 'in_features' }` | No `$` prefix — references node params directly |
| `{ "kind": "wildcard" }` | `{ kind: 'wildcard' }` | Matches zero or more dims |

**`$` prefix rule**: In JSON, symbolic dimension names start with `$` (e.g., `"$B"`, `"$H"`, `"$W"`). This distinguishes them from param_ref names. When loaded into `ShapeDimPattern`, the `$` is stripped: `"$B"` → `{ kind: 'symbolic', name: 'B' }`. Param refs never have `$`.

---

## Implementation Notes for stereotype.ts

- The `type_signature` parsing from JSON to `TypeSignature` must strip the `$` prefix from symbolic dimension names.
- Example parse logic (pseudocode — embed in constructor or a private helper):

```typescript
private parseTypeSignature(raw: TypeSignature | undefined): TypeSignature | undefined {
  if (!raw) return undefined;
  // Deep-clone and strip $ from symbolic names
  return {
    kind: raw.kind,
    input: Array.isArray(raw.input)
      ? raw.input.map(p => this.stripDollar(p))
      : this.stripDollar(raw.input),
    output: raw.output.map(p => this.stripDollar(p)),
    dtype: raw.dtype ? { ...raw.dtype } : undefined,
  };
}

private stripDollar(pattern: ShapeDimPattern): ShapeDimPattern {
  if (pattern.kind === 'symbolic' && pattern.name.startsWith('$')) {
    return { ...pattern, name: pattern.name.slice(1) };
  }
  return pattern;
}
```

- **Do NOT** validate the `type_signature` structurally (e.g., checking that it has the right number of dims). That's the TypeEngine's job.
- Only do syntactic normalization: strip `$`, deep-clone to avoid mutation of the loaded JSON data.

---

## Test Plan

- `npm run check` — TypeScript must compile without errors in `stereotype.ts`
- `npm run dev` — App must still load, edit, compile diagrams without regression
- Existing vitest tests (`nnTree.test.ts`, `utils.test.ts`) must pass unchanged
- No dedicated tests for this task; the type engine tests (frontend-4) will validate correct parsing indirectly
