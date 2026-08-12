# Task — param_spread: Tuple Parameter Expansion for Shape Rank Changes

**Delegate to**: `@frontend`  
**Depends on**: Phase 1 complete (tensortypes, typeEngine, stereotype all exist)

---

## Objective

Add a new pattern kind `param_spread` to the type signature system. This enables modules like `nn.Unflatten` (and future `nn.Reshape`) to declare output shapes that expand a single tensor dimension into multiple dimensions, using a tuple parameter.

**Problem**: The current type system cannot model operations that increase tensor rank. Each pattern kind (`const`, `symbolic`, `param_ref`, `wildcard`, `computed`) produces exactly one dimension in the output. Unflatten takes `[B, 100]` (2D) and produces `[B, 1, 100]` (3D) — the output has MORE dimensions than the input.

**Solution**: A new pattern kind that reads a tuple parameter (e.g. `(1, 100)`) and expands it into multiple output dimensions.

---

## Part A — Extend `tensortypes.ts`

Add a new variant to `ShapeDimPattern`:

```typescript
export type ShapeDimPattern =
  | { kind: 'const'; value: number }
  | { kind: 'symbolic'; name: string }
  | { kind: 'param_ref'; name: string }
  | { kind: 'wildcard' }
  | { kind: 'computed'; expr?: string; formula?: string; args?: string[] }
  | { kind: 'param_spread'; param: string };  // NEW
```

And a new variant to `ShapeDimension`:

```typescript
export type ShapeDimension =
  | { kind: 'const'; value: number }
  | { kind: 'symbolic'; name: string }
  | { kind: 'param_ref'; name: string }
  | { kind: 'wildcard' }
  | { kind: 'computed'; expr?: string; formula?: string; args?: string[]; value?: number }
  | { kind: 'param_spread'; param: string; values?: number[] };  // NEW
```

**Semantics**: `param_spread` reads a tuple parameter (e.g. `unflattened_size = (1, 100)`) and produces N dimensions (one per tuple element). The parameter value is parsed as a comma-separated list of integers.

---

## Part B — Extend `typeEngine.ts`

### B1. Handle `param_spread` in `patternMatch()`

In `patternMatch`, add a new case for `param_spread`:

```typescript
case "param_spread": {
  // param_spread in input pattern: consume N dims where N = tuple length
  const resolved = TypeEngine.resolveParamRef(p.param, params);
  if (resolved.status !== "resolved") {
    // Param not yet set — treat as wildcard, capture remaining dims
    let remainingRequired = 0;
    for (let k = j + 1; k < pattern.length; k++) {
      if (pattern[k].kind !== "wildcard") remainingRequired++;
    }
    const available = inputDims.length - i;
    const toConsume = Math.max(0, available - remainingRequired);
    for (let c = 0; c < toConsume; c++) {
      captured.push(inputDims[i]);
      i++;
    }
    j++;
    break;
  }
  // Parse tuple: "(1, 100)" or "1, 100" → [1, 100]
  const tupleLen = parseTupleLength(resolved.value);
  if (tupleLen === undefined) {
    return {
      nodeId: "",
      message: `param_spread: "${p.param}" has invalid tuple value`,
      severity: "error",
    } satisfies TypeError;
  }
  // Consume exactly tupleLen dims from input
  for (let c = 0; c < tupleLen; c++) {
    if (i + c >= inputDims.length) {
      return {
        nodeId: "",
        message: `param_spread: expected ${tupleLen} dims but input has only ${inputDims.length - i} remaining`,
        severity: "error",
      } satisfies TypeError;
    }
    captured.push(inputDims[i + c]);
    i += 1;
  }
  j++;
  break;
}
```

### B2. Handle `param_spread` in `resolvePattern()`

In `resolvePattern`, add a new case for `param_spread`:

```typescript
case "param_spread": {
  const resolved = TypeEngine.resolveParamRef(p.param, params);
  if (resolved.status === "resolved") {
    // Parse tuple: "(1, 100)" → [1, 100]
    const values = parseTuple(resolved.value);
    if (values !== undefined) {
      for (const v of values) {
        result.push({ kind: "const", value: v });
      }
    } else {
      // Invalid tuple — push symbolic
      result.push({ kind: "symbolic", name: `?${p.param}` });
    }
  } else {
    // Unset — push symbolic placeholder
    result.push({ kind: "symbolic", name: `?${p.param}` });
  }
  break;
}
```

### B3. Add helper functions

```typescript
/**
 * Parse a tuple value from a resolved parameter.
 * Handles "(1, 100)", "1, 100", "(1)", "1" → [1, 100], [1, 100], [1], [1]
 * Returns undefined if not a valid tuple.
 */
function parseTuple(value: number): number[] | undefined {
  // value is already a number (scalar) — return as single-element array
  return [value];
}

// Overload for string param values
function parseTupleFromString(value: string): number[] | undefined {
  const cleaned = value.replace(/[()[\]]/g, "").trim();
  if (!cleaned) return undefined;
  const parts = cleaned.split(",").map(s => parseInt(s.trim(), 10));
  if (parts.some(isNaN)) return undefined;
  return parts;
}
```

Note: The `resolveParamRef` returns a number for resolved params. But tuple params are stored as strings like `"(1, 100)"`. We need to handle string-to-tuple parsing. The `resolveParamRef` already handles this — when `val` is a string like `"(1, 100)"`, it tries `Number(val)` which fails, so it returns `invalid`. We need to add tuple-aware resolution.

**Better approach**: Add a `resolveParamRefTuple` that returns `number[] | undefined`:

```typescript
static resolveParamRefTuple(name: string, params: Record<string, unknown>): number[] | undefined {
  const raw = params[name];
  if (raw === undefined || raw === null) return undefined;
  const val = typeof raw === "object" && raw !== null && "value" in raw
    ? (raw as Record<string, unknown>).value
    : raw;
  if (typeof val === "number") return [val];
  if (typeof val === "string") {
    if (val === "None" || val === "Undefined" || val === "") return undefined;
    const cleaned = val.replace(/[()[\]]/g, "").trim();
    const parts = cleaned.split(",").map(s => parseInt(s.trim(), 10));
    if (parts.some(isNaN)) return undefined;
    return parts;
  }
  return undefined;
}
```

---

## Part C — Update `Unflatten.json`

Change the output pattern from wildcard to `param_spread`:

```json
{
  "category": "Layer",
  "pythonClassName": "nn.Unflatten",
  "view": {
    "color": "#a9a9a9",
    "width": 120,
    "height": 50
  },
  "params": {
    "dim": {
      "type": "int",
      "default": "1"
    },
    "unflattened_size": {
      "type": "int | tuple",
      "default": "Undefined"
    }
  },
  "type_signature": {
    "kind": "module",
    "input": [
      { "kind": "symbolic", "name": "$B" },
      { "kind": "wildcard" }
    ],
    "output": [
      { "kind": "symbolic", "name": "$B" },
      { "kind": "param_spread", "param": "unflattened_size" }
    ]
  }
}
```

**How it works**:
- Input: `[B, 100]` → wildcard captures `100`
- Output: `$B` + `param_spread("unflattened_size")` → `[B, 1, 100]`

---

## Part D — Tests

Add to `typeEngine.test.ts`:

### D1. Basic Unflatten test

```
Input: [B, 784] → Unflatten(dim=1, unflattened_size=(1, 784))
Output: [B, 1, 784]
```

### D2. Unflatten with different tuple

```
Input: [B, 128] → Unflatten(dim=1, unflattened_size=(4, 32))
Output: [B, 4, 32]
```

### D3. Unflatten error — invalid tuple

```
Input: [B, 100] → Unflatten(dim=1, unflattened_size="cazz")
Output: error (invalid tuple)
```

### D4. Unflatten error — param not set

```
Input: [B, 100] → Unflatten(dim=1, unflattened_size=Undefined)
Output: error (param not set)
```

### D5. Unflatten with Conv1d chain

```
Input: [B, 784] → Linear(784, 100) → Unflatten(1, (1, 100)) → Conv1d(1, 10, kernel_size=3)
Output: [B, 10, 98]  (1D conv with kernel=3)
```

### D6. Param spread with single value

```
Input: [B, 100] → Unflatten(dim=1, unflattened_size=100)
Output: [B, 100]  (single value = same as input)
```

---

## Part E — Edge Cases

### E1. Unflatten with dim=0 (batch dimension)

If `dim=0`, the spread would replace the batch dimension. This is unusual but should work:
- Input: `[B, 100]` → Unflatten(dim=0, unflattened_size=(2, 50))
- Output: `[2, 50, 100]` — batch dim is replaced

The implementation should handle this by inserting new dims at the `dim` position.

### E2. Unflatten with dim at end

If `dim=2` on `[B, L]` (2D), the spread adds new dims after L:
- Input: `[B, 100]` → Unflatten(dim=2, unflattened_size=(1, 100))
- Output: `[B, 100, 1, 100]`

### E3. Multiple param_spread in one pattern

Not supported — `param_spread` can only appear once per pattern. Multiple tuple expansions are too complex.

---

## Execution Order

1. Extend `tensortypes.ts` (Part A)
2. Extend `typeEngine.ts` (Part B)
3. Update `Unflatten.json` (Part C)
4. Add tests (Part D)
5. Run `npx vitest run` and `npm run check`
6. Commit: "feat: param_spread — tuple parameter expansion for shape rank changes"
