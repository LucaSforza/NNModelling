# Task frontend-4 — TypeEngine Unit Tests

**Delegate to**: `@frontend`  
**Depends on**: `frontend-1`, `frontend-2`, `frontend-3` (all implementation must exist)  
**Estimated files**: 1 new file, 1 modified

---

## Objective

Create comprehensive unit tests for the type engine in `front-end/src/__tests__/typeEngine.test.ts`. Follow the existing testing style of `nnTree.test.ts`.

---

## Files to Create

| File | Action |
|------|--------|
| `front-end/src/__tests__/typeEngine.test.ts` | CREATE |

## Files to Modify

| File | Action |
|------|--------|
| `front-end/src/__tests__/helpers.ts` | Add test helper `expectShape()` |

---

## Test Style Conventions

- Use `describe`/`it` blocks from vitest
- Use `import { describe, it, expect } from 'vitest'`
- Use the real `Diagram` class (it works in vitest via the Vite/Svelte plugin, same as `nnTree.test.ts`)
- Reuse existing `node()` and `edge()` factory functions from `helpers.ts` where applicable
- If new factories are needed, add them to `helpers.ts`
- Each test creates a fresh `Diagram`, sets up nodes/edges, calls `TypeEngine.infer(diagram)`, and asserts

---

## Test Cases

### Group 1 — Happy Path: Simple Sequential Chains

#### Test 1.1: Input → Linear (matching params)

```
Setup:
  const diagram = new Diagram();
  // Replace auto-spawned Input with explicit out_features
  const inputId = diagram.nodes[0].id;
  diagram.updateModule(inputId, { params: { out_features: '784' } });
  // Add Linear with matching in_features
  diagram.addModule('Linear', 200, 0, { params: { in_features: '784', out_features: '256' } });
  const linearId = diagram.nodes.find(n => n.data.stereotype === 'Linear')!.id;
  diagram.edges.push(edge('e1', inputId, linearId));

  const result = TypeEngine.infer(diagram);

Assert:
  result.ok === true
  result.errors.length === 0
  result.annotations.has(inputId) === true
  result.annotations.has(linearId) === true

  // Input annotation
  const inputAnn = result.annotations.get(inputId)!;
  inputAnn.inputType === undefined  // Input is source
  inputAnn.outputType.shape[0] = { kind: 'symbolic', name: 'B' }  // batch dim
  inputAnn.outputType.shape[1] = { kind: 'const', value: 784 }
  inputAnn.outputType.dtype === 'float32'

  // Linear annotation
  const linearAnn = result.annotations.get(linearId)!;
  linearAnn.inputType!.shape[1] = { kind: 'const', value: 784 }
  linearAnn.outputType.shape[1] = { kind: 'const', value: 256 }
  linearAnn.outputType.dtype === 'float32'
```

#### Test 1.2: Input → Linear → ReLU

```
Setup:
  Input(784) → Linear(784, 256) → ReLU

Assert:
  result.ok === true
  ReLU outputType.shape equals Linear outputType.shape (shape-preserving)
  ReLU outputType.dtype === 'float32'
```

#### Test 1.3: Input with wildcard → Linear

```
Setup:
  // Input with shape [B, 784], Linear with pattern [B, *, in_features]
  Input(out_features=784) → Linear(in_features=784, out_features=256)

Assert:
  result.ok === true
  Linear inputType.shape.length === 2  // [B, 784]
  Linear outputType.shape.length === 2  // [B, 256]
```

---

### Group 2 — Shape Mismatch Errors

#### Test 2.1: Linear in_features mismatch

```
Setup:
  Input(out_features=784) → Linear(in_features=512, out_features=256)

Assert:
  result.ok === false
  result.errors.length >= 1
  const err = result.errors[0];
  err.nodeId === linearId
  err.severity === 'error'
  err.message includes 'in_features' or '512' or '784' or 'mismatch'
```

#### Test 2.2: Linear with extra dimension not covered by wildcard

```
Setup:
  Input(out_features=784) → Linear(in_features=784, out_features=256)
  But Linear pattern is [B, in_features] (no wildcard)
  Input produces [B, 784]

  -- Actually this would match. Need a case where input has MORE dims than pattern expects.
  -- Input shape [B, 128, 784] vs pattern [B, in_features] (no wildcard for the 128)

Wait — the test should create a scenario where the number of dimensions mismatches.
For Phase 1, this can only happen if no wildcard is present and the number of dims differs.

Actually in our current design, Input produces [B, out_features] = 2 dims. Linear expects [B, *, in_features] = 3 pattern elements but wildcard can match zero dims. So [B, 784] against [B, *, in_features] with wildcard consuming 0 dims → matches!

Let me think about what actually causes a mismatch...

A mismatch would happen if:
1. in_features doesn't match (test 2.1 covers this)
2. dtype doesn't match (test 2.4)
3. Pattern has MORE required dims than input provides: pattern [B, C, H, W] vs input [B, 784]

So for test 2.2, a pattern without wildcard that requires more dims than provided:
```

**Revised test 2.2**:

```
Setup:
  // Manually construct a scenario: pattern expects 3 fixed dims, input has only 2
  // This would need a custom stereotype. Or: test via inferNode directly.
  // Simpler: use inferNode with explicit input shape

  const linearStereotype = diagram.stereotypes.find(s => s.name === 'Linear')!;
  const inputType: TensorType = {
    shape: [{ kind: 'const', value: 32 }],  // only 1 dim, but Linear expects [B, *, in_features]
    dtype: 'float32'
  };
  const params = { in_features: '784', out_features: '256' };
  const env: TypeEnvironment = new Map();

  const result = TypeEngine.inferNode(inputType, linearStereotype, params, env);

Assert:
  result is TypeError (not TensorType)
  (result as TypeError).message includes 'dimension' or 'expected' or 'position'
```

#### Test 2.3: Unresolved param_ref (param is "Undefined") — soft warning

```
Setup:
  Input(out_features=784) → Linear(in_features='Undefined', out_features=256)

Assert:
  result.ok === true  // should not be a hard error
  // Linear output last dim should be symbolic [?,out_features]
  // Or: a warning is recorded
  // Design decision: in Phase 1, unresolved params produce warnings, not errors
  const warnings = result.errors.filter(e => e.severity === 'warning');
  warnings.length >= 0  // at least one warning about unresolved param
```

#### Test 2.4: Dtype mismatch

```
Setup:
  // Use inferNode to test a custom type_signature with dtype constraint
  // Or: add a stereotype with explicit dtype check
  // Simpler approach for Phase 1: test directly via inferNode

  // Create a TestStereotype-like object manually with a type_signature that
  // expects float64 on input but receives float32

  const sig: TypeSignature = {
    kind: 'module',
    input: [{ kind: 'wildcard' }],
    output: [{ kind: 'wildcard' }],
    dtype: { input: 'float64' }
  };

  // Construct a Stereotype-like object or test the pattern matching directly
  // TODO: decide whether to expose dtype checking in inferNode or test internally

  // For now: if dtype constraint is implemented, test it.
  // If not yet implemented in Phase 1, mark as skipped: it.skip(...)
```

---

### Group 3 — Edge Cases

#### Test 3.1: No type_signature (module without annotation)

```
Setup:
  // Use Fork node (has no type_signature)
  Input(784) → Fork

Assert:
  result.ok === true  // not an error, just skipped
  result.errors.some(e => e.severity === 'warning' && e.message.includes('type signature'))
  Fork outputType.dtype === 'unknown'  // or similar placeholder
```

#### Test 3.2: Disconnected node (floating in canvas)

```
Setup:
  Input(784) → Linear(784, 256)   (connected)
  ReLU floating with no edges

Assert:
  result.ok === true
  result.annotations.has(reluId) === false  // not traversed
  // OR: ReLU present but with unknown type
```

#### Test 3.3: Empty diagram (only Input node)

```
Setup:
  const diagram = new Diagram();  // auto-spawns Input
  const result = TypeEngine.infer(diagram);

Assert:
  result.ok === true
  result.annotations.has(inputId) === true
  result.annotations.get(inputId)!.outputType.shape[1] = { kind: 'const', value: 784 }
```

#### Test 3.4: Join node (Phase 3 TODO)

```
Setup:
  Input(784) → Linear_1(784, 128) → Addition Join
  Input(784) → Linear_2(784, 128) → Addition Join

Assert:
  result.ok === true  // join not checked yet
  result.errors.some(e => e.severity === 'warning' && e.message.includes('join'))
```

#### Test 3.5: Multiple symbolic dimensions binding consistently

```
Setup:
  // If we had a module where input pattern has [B, C, H, W] and output pattern also has [B, C, H, W]
  // but with different C values — this would require a module with explicit multi-symbolic pattern
  // Not applicable in Phase 1 (no such module), so skip.
  it.skip('symbolic unification across multiple occurrences', () => { ... })
```

---

### Group 4 — Wildcard Behavior

#### Test 4.1: Wildcard consumes zero dimensions

```
Setup:
  Input(784) → Linear(784, 256)
  // Linear pattern: [B, *, in_features], input: [B, 784]
  // Expected: wildcard matches 0 dims, output: [B, 256]

Assert:
  const linearAnn = result.annotations.get(linearId)!;
  linearAnn.outputType.shape.length === 2
```

#### Test 4.2: Wildcard consumes one dimension (future test)

```
Setup:
  // To test this we'd need input with shape [B, 128, 784]
  // Input currently only produces [B, out_features] so this requires
  // a different module that introduces an intermediate dim.
  // Mark as skipped for Phase 1.

  it.skip('wildcard consumes one intermediate dimension', () => { ... })
```

---

### Group 5 — Error Message Quality

#### Test 5.1: Error message includes node ID

```
Setup: mismatch scenario from Test 2.1

Assert:
  result.errors[0].nodeId is a non-empty string
```

#### Test 5.2: Error message is human-readable

```
Setup: mismatch scenario from Test 2.1

Assert:
  result.errors[0].message.length > 10
  result.errors[0].message does not contain stack traces or internal names
```

---

## Helper to Add in `helpers.ts`

```typescript
import type { TypeResult, ShapeDimension } from '../conversion/tensortypes';

/**
 * Assert that a TypeResult is successful (no errors with severity 'error').
 */
export function expectTypeSuccess(result: TypeResult): void {
  const hardErrors = result.errors.filter(e => e.severity === 'error');
  if (hardErrors.length > 0) {
    throw new Error(`Expected type success but got errors: ${hardErrors.map(e => e.message).join('; ')}`);
  }
}

/**
 * Assert that a node in the TypeResult has the expected output shape.
 * Shape is specified as an array of descriptive strings:
 *   "784" → const dim with value 784
 *   "$B"  → symbolic dim with name "B"
 *   "*"   → wildcard
 *
 * Wildcards are not checked strictly (they're intermediate representations).
 */
export function expectOutputShape(
  result: TypeResult,
  nodeId: string,
  expected: string[]
): void {
  const ann = result.annotations.get(nodeId);
  if (!ann) throw new Error(`No annotation found for node ${nodeId}`);
  const shape = ann.outputType.shape;
  if (shape.length !== expected.length) {
    throw new Error(`Shape length mismatch for ${nodeId}: expected ${expected.length} dims, got ${shape.length}`);
  }
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const dim = shape[i];
    if (exp.startsWith('$')) {
      // Symbolic dim
      if (dim.kind !== 'symbolic') throw new Error(`Expected symbolic dim at position ${i}, got ${dim.kind}`);
      if (dim.name !== exp.slice(1) && dim.name !== exp) {
        // Allow either "$B" matching {name:'B'} or exact match
        throw new Error(`Symbolic name mismatch at ${i}: expected ${exp.slice(1)}, got ${dim.name}`);
      }
    } else if (exp === '*') {
      // Wildcard — skip strict check
      continue;
    } else {
      // Const dim
      const val = parseInt(exp, 10);
      if (isNaN(val)) throw new Error(`Invalid expected shape value: ${exp}`);
      if (dim.kind !== 'const') throw new Error(`Expected const dim at position ${i}, got ${dim.kind}`);
      if (dim.value !== val) throw new Error(`Const value mismatch at ${i}: expected ${val}, got ${dim.value}`);
    }
  }
}

/**
 * Assert that a TypeResult contains a specific error for a node.
 */
export function expectTypeError(
  result: TypeResult,
  nodeId: string,
  messageContains?: string
): void {
  const matching = result.errors.filter(e => e.nodeId === nodeId);
  if (matching.length === 0) {
    throw new Error(`No errors found for node ${nodeId}. Errors: ${result.errors.map(e => `${e.nodeId}: ${e.message}`).join('; ')}`);
  }
  if (messageContains) {
    const hasMessage = matching.some(e => e.message.includes(messageContains));
    if (!hasMessage) {
      throw new Error(`No error for ${nodeId} contains "${messageContains}". Errors: ${matching.map(e => e.message).join('; ')}`);
    }
  }
}
```

---

## Implementation Order

The tests should be implemented in this order (matching the groups above):

1. **Group 1** (Happy Path) — must pass first
2. **Group 5** (Error Messages) — basic assertions on error format
3. **Group 2** (Mismatches) — shape and dtype errors
4. **Group 3** (Edge Cases) — missing signatures, disconnected nodes, joins, empty diagrams
5. **Group 4** (Wildcards) — zero-consumption case

Tests that depend on Phase 2+ features should be added with `it.skip()` to document the intended behavior.

---

## Important Constraints

- Tests must use `vitest` (already configured, see `vitest.config.ts`)
- Tests must pass after `frontend-3` is implemented
- Existing tests (`nnTree.test.ts`, `utils.test.ts`) must continue to pass
- Do NOT modify `nnTree.test.ts` or `utils.test.ts`
- The test file should be ~150-250 lines
