# Task frontend-3 — TypeEngine Implementation

**Delegate to**: `@frontend`  
**Depends on**: `frontend-1` (tensortypes.ts), `frontend-2` (stereotype + JSON)  
**Estimated files**: 1 new file

---

## Objective

Create `front-end/src/conversion/typeEngine.ts` — the constraint-based type inference engine. This is a **pure function** that takes Diagram data and returns type annotations + errors.

The engine must be **data-driven**: it interprets `type_signature` from stereotypes and contains **no** hardcoded module-specific logic (`Linear`, `Conv2d`, `ReLU`, etc.) or stereotype name checks.

---

## Files to Create

| File | Action |
|------|--------|
| `front-end/src/conversion/typeEngine.ts` | CREATE |

## Files to Modify

None.

---

## Architecture

```
TypeEngine
├── infer(diagram): TypeResult          ← PUBLIC entry point
├── inferNode(inputType, stereotype, params, env): ...  ← PUBLIC helper for single-node inference
│
├── [private] topologicalSort(diagram): string[]
├── [private] patternMatch(inputDims, pattern, params, env): PatternResult
├── [private] resolvePattern(pattern, params, env, captured): ShapeDimension[]
├── [private] resolveParamRef(name, params): number | undefined
└── [private] resolveSymbolic(name, env): ShapeDimension | undefined
```

---

## Detailed Spec

### 1. Public API

#### `TypeEngine.infer(diagram: Diagram): TypeResult`

Full-graph type inference. Steps:

1. **Build topological order** of all nodes (private `topologicalSort`)
2. **Initialize** empty `TypeEnvironment`, empty `annotations` Map, empty `errors` array
3. **Traverse** nodes in topological order:
   a. Get the node's `Stereotype` from `diagram.stereotypes` (match by `node.data.stereotype`)
   b. If no stereotype or no `typeSignature`: emit warning "No type signature", store `outputType = { shape: [], dtype: 'unknown' }`, continue
   c. Get the node's resolved params (from `node.data.params`)
   d. Determine input type(s):
      - If Input node (`stereotype.isInput`): `inputType = undefined`
      - If one predecessor: `inputType = annotations.get(predecessorId).outputType`
      - If multiple predecessors (join): `inputTypes = [annotations.get(p1).outputType, ...]`
      - If no predecessor and not Input: skip (floating node, not connected)
   e. Call `inferNode(inputType, stereotype, params, env)`
   f. If result is `TypeError`: push to errors, skip annotation
   g. If result is output type: store `NodeTypeAnnotation`, update `env` with any new symbolic bindings
4. **Return** `{ ok: errors.every(e => e.severity !== 'error'), annotations, errors }`

#### `TypeEngine.inferNode(inputType: TensorType | undefined, stereotype: Stereotype, params: Record<string, any>, env: TypeEnvironment): TensorType | TypeError`

Single-node type inference. Steps:

1. If `stereotype.typeSignature` is undefined: return warning-type `TypeError` with `severity: 'warning'`
2. Get `sig = stereotype.typeSignature`
3. If `sig.kind === 'module'`:
   - `inputPattern = sig.input as ShapePattern` (single pattern)
   - If `inputType` is undefined (source node) and pattern is `[]`: skip input matching, proceed to output resolution
   - If `inputType` is undefined but pattern is not `[]`: error "node expects input but has no predecessor"
   - Call `patternMatch(inputType.shape, inputPattern, params, env)`
   - If patternMatch fails: return the TypeError
   - Resolve output: `outputDims = resolvePattern(sig.output, params, env, patternMatch.captured)`
   - Resolve dtype: if `sig.dtype?.output` → use it; else → `inputType.dtype`
   - Return `{ shape: outputDims, dtype }`
4. If `sig.kind === 'join'`:
   - **Phase 3 TODO** — emit warning "join type inference not yet supported", return unknown type
5. If `sig.kind === 'subflow'`:
   - **Phase 4 TODO** — emit warning "subflow type inference not yet supported", return unknown type

---

### 2. Private: `topologicalSort(diagram: Diagram): string[]`

Kahn's algorithm on `diagram.nodes` and `diagram.edges`:

```
1. Build adjacency list: for each edge e, source → target
2. Build in-degree map: for each node, count incoming edges
3. Queue = all nodes with in-degree 0
4. While queue not empty:
   - dequeue node, add to result
   - for each child of node, decrement in-degree
   - if child in-degree becomes 0, enqueue
5. Return result array
```

**Edge case**: if graph has a cycle, Kahn's will leave some nodes unvisited. In that case, emit a warning "graph contains cycle, partial type inference" and return what we have.

**Implementation note**: use `diagram.edges` where each edge has `source` (node ID) and `target` (node ID). Use `diagram.nodes` to get all node IDs. Handle subflow nesting: only traverse nodes at the top level (`parentId === undefined` for top-level nodes in SvelteFlow).

---

### 3. Private: `patternMatch(inputDims: ShapeDimension[], pattern: ShapePattern, params: Record<string, any>, env: TypeEnvironment): PatternMatchResult`

This is the **core algorithm**. It matches a resolved input shape against a declared pattern.

```typescript
interface PatternMatchResult {
  success: true;
  /** New or updated symbolic bindings (merged into env after match) */
  bindings: TypeEnvironment;
  /** Dimensions captured by wildcards, in order */
  captured: ShapeDimension[];
}
```

Or returns a `TypeError` if matching fails.

**Algorithm** (two-pointer walk):

```
Let i = 0  (index into inputDims)
Let j = 0  (index into pattern)
Let bindings = new Map(env)   // copy existing
Let captured: ShapeDimension[] = []

WHILE j < pattern.length:
  p = pattern[j]

  SWITCH p.kind:

    CASE 'const':
      if i >= inputDims.length: return TypeError("expected dim at position j, got end of shape")
      if inputDims[i].kind !== 'const' || inputDims[i].value !== p.value:
        return TypeError(`dimension mismatch at position ${j}: expected ${p.value}, got ${describeDim(inputDims[i])}`)
      i++; j++
      // const dim is not added to captured (it's consumed and verified)

    CASE 'symbolic':
      if i >= inputDims.length: return TypeError("expected dim at position j, got end of shape")
      let existing = bindings.get(p.name)
      if existing !== undefined:
        // Already bound — unify
        if !dimEqual(existing, inputDims[i]):
          return TypeError(`symbolic ${p.name} already bound to ${describeDim(existing)}, cannot unify with ${describeDim(inputDims[i])}`)
      else:
        // First occurrence — bind
        bindings.set(p.name, inputDims[i])
      i++; j++
      // symbolic dim is NOT added to captured (it's used for binding, not propagation)

    CASE 'param_ref':
      let resolved = resolveParamRef(p.name, params)
      if resolved === undefined:
        // Param is "Undefined" or missing — treat as warning, skip check
        // Create a new symbolic dim representing the unresolved param
        captured.push({ kind: 'symbolic', name: `?${p.name}` })
        i++; j++
      else:
        if i >= inputDims.length: return TypeError(...)
        if inputDims[i].kind !== 'const' || inputDims[i].value !== resolved:
          return TypeError(`dimension mismatch: param ${p.name}=${resolved}, got ${describeDim(inputDims[i])}`)
        i++; j++

    CASE 'wildcard':
      // Consume all remaining input dims for this wildcard
      // BUT: if this is the LAST pattern element, consume all remaining
      // If there are pattern elements after this, we need lookahead
      // SIMPLE RULE for Phase 1: if this is the last pattern element, consume rest
      //                          if not the last, consume until the next pattern element can match
      //                          (complex lookahead deferred to Phase 2; for now, single wildcard
      //                           that consumes all remaining dims and MUST be last)
      if j < pattern.length - 1:
        return TypeError("wildcard is only supported as the last non-wildcard element in Phase 1")
      // Consume all remaining input dims
      while i < inputDims.length:
        captured.push(inputDims[i])
        i++
      j++

END WHILE

// After pattern consumed, check no extra input dims remain
if i < inputDims.length:
  return TypeError(`expected ${pattern.length} dimensions in pattern, but input has ${inputDims.length} dims (extra dims at positions ${i}..${inputDims.length-1})`)

return { success: true, bindings, captured }
```

**Wildcard constraint for Phase 1**: Only one wildcard is allowed per pattern, and it must be the last non-terminal pattern element. This simplifies lookahead logic. Future phases can relax this.

**`dimEqual(a, b)` helper**: Two dimensions are equal if they have the same kind and value/name.

---

### 4. Private: `resolvePattern(pattern: ShapePattern, params: Record<string, any>, env: TypeEnvironment, captured: ShapeDimension[]): ShapeDimension[]`

Resolve an output pattern to a concrete shape, substituting bindings and captured wildcards:

```
Let result: ShapeDimension[] = []
Let capIdx = 0  // index into captured array

FOR EACH p in pattern:
  SWITCH p.kind:
    CASE 'const':
      result.push({ kind: 'const', value: p.value })

    CASE 'symbolic':
      let bound = env.get(p.name)
      if bound !== undefined:
        result.push(bound)
      else:
        // Symbolic variable unbound — keep it symbolic in output
        // (e.g., B was bound earlier in input, but if somehow not, propagate as symbolic)
        result.push({ kind: 'symbolic', name: p.name })

    CASE 'param_ref':
      let val = resolveParamRef(p.name, params)
      if val !== undefined:
        result.push({ kind: 'const', value: val })
      else:
        result.push({ kind: 'symbolic', name: `?${p.name}` })

    CASE 'wildcard':
      // Substitute all captured dimensions at this position
      while capIdx < captured.length:
        result.push(captured[capIdx])
        capIdx++

RETURN result
```

---

### 5. Private helpers

```typescript
/**
 * Resolve a parameter reference from a node's parameter map.
 * Returns undefined if the parameter is "Undefined", missing, or cannot be parsed as a number.
 */
function resolveParamRef(name: string, params: Record<string, any>): number | undefined {
  const raw = params[name];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    if (raw === 'Undefined' || raw === '' || raw === 'None') return undefined;
    const parsed = Number(raw);
    return isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Describe a dimension for error messages.
 */
function describeDim(d: ShapeDimension): string {
  switch (d.kind) {
    case 'const': return String(d.value);
    case 'symbolic': return `$${d.name}`;
    case 'param_ref': return `params.${d.name}`;
    case 'wildcard': return '*';
  }
}
```

---

## Edge Cases

| Case | Behavior |
|------|----------|
| Stereotype has no `typeSignature` | `TypeError` with `severity: 'warning'`, output type = `{ shape: [], dtype: 'unknown' }` |
| Node has no predecessor and is not Input | Skip (floating node, no type to infer) |
| Join node with `sig.kind === 'join'` | TODOne warning, return unknown type |
| Subflow node with `sig.kind === 'subflow'` | TODOne warning, return unknown type |
| Input pattern is `[]` (empty) | Node is a source — skip input matching |
| `params.in_features === "Undefined"` | `resolveParamRef` returns `undefined` → warning or skip check |
| Multiple wildcards in one pattern | Error: "only one wildcard allowed per pattern in Phase 1" |
| Cycle in graph | Warning, partial inference |
| Subflow-children nodes | Not traversed in top-level sort (only parentId=undefined nodes). Subflow internals are deferred to Phase 4. |

---

## What NOT to Implement

- ❌ No hardcoded module names (`if (stereotype.name === 'Linear')`)
- ❌ No hardcoded category checks (`if (stereotype.category === 'Layer')`)
- ❌ No Conv2d output size formula
- ❌ No Flatten dimension computation
- ❌ No multi-input join type inference
- ❌ No subflow internal graph traversal
- ❌ No editor integration (no calls to FlowCanvas, Sidebar, etc.)
- ❌ No mutation of Diagram state (read-only)

---

## Test Plan

See `frontend-4-typeEngine-test.md`. This file is tested entirely through `typeEngine.test.ts`.
