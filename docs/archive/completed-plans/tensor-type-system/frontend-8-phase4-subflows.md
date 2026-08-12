# Task frontend-8 — Phase 4: Subflow Type Inference

> Historical design note. The implementation has since evolved: subflow
> inference uses declarative `SubflowConfig`, shares the main annotation and
> diagnostic collections, and records `blockedBy` provenance when downstream
> inference is skipped. Treat the current `typeEngine.ts` and
> `docs2/source/type_system.rst` as authoritative for runtime behavior.

**Delegate to**: `@frontend`
**Depends on**: Phase 1 + Phase 2 + Phase 3 complete

---

## Objective

Implement recursive type inference for subflow containers and add `type_signature` to Repeat/HorizontalRepeat behavioral stereotypes. This replaces the current stub at `typeEngine.ts:454` that returns `{ shape: [], dtype: "unknown" }`.

---

## Part A — Subflow Recursive Inference

### A1. Strategy

A subflow node in the top-level graph encapsulates an internal DAG of child nodes (`parentId === subflowNodeId`). Type inference for a subflow is **recursive**: run `TypeEngine.infer()` on the internal graph, using the subflow's external input type as the internal Input node's output type.

Two sub-cases:

| Sub-case | Behavior | How to detect |
|----------|----------|---------------|
| **Generic subflow** (no behavioral stereotype) | Recursive inference. Subflow output type = internal exit node's output type. | `stereotype.isSubFlow && !isRepeat && !isHorizontalRepeat` |
| **Repeat** | Shape-preserving: output = input shape. `[B, *] → [B, *]`. | `stereotype.name === "Repeat"` |
| **HorizontalRepeat** | Output last dim = input last dim × `n`. `[B, *, d] → [B, *, n·d]`. | `stereotype.name === "HorizontalRepeat"` |

### A2. Algorithm — Generic Subflow

```
case "subflow":
  1. If stereotype is Repeat or HorizontalRepeat → delegate to Part B/C
  2. Get internal child nodes: diagram.nodes.filter(n => n.parentId === nodeId)
  3. Get internal edges: diagram.edges.filter(e => both source and target are internal)
  4. Identify internal Input node (stereotype.isInput, inside subflow)
  5. Identify internal exit node(s) — nodes with no outgoing edges inside the subflow
     (or nodes whose outgoing edges go to the subflow boundary)
  6. Override internal Input's type: set its annotation outputType = subflow's external inputType
     (this "injects" the external input into the internal graph)
  7. Run TypeEngine.infer() on the internal sub-graph (recursive call)
     - Only internal nodes participate
     - The internal Input is already annotated with the external input type
  8. Collect output types from all internal exit nodes
  9. If one exit node → subflow output type = that exit node's output type
     If multiple exit nodes → the subflow has multiple outputs (future extension; for now warn
     and use first exit node's type)
  10. Return the output type
```

**Key design decision**: The recursive call creates a lightweight "mini-inference" pass. It does NOT modify the main `annotations`/`errors` — subflow-internal errors are reported with `nodeId` pointing to the subflow node, and the message prefixed with `[Subflow]`.

### A3. Entry/Exit Detection

- **Entry node**: The internal node with `stereotype.isInput === true`. If none found, use the node with no internal incoming edges (topological source). If multiple, warn and use the first.

- **Exit node(s)**: Internal nodes with no internal outgoing edges. Since NNModelling uses implicit forks, there can be multiple.

For Phase 4, we assume a single exit node. Multi-exit subflows will get a warning and use the first exit's type.

### A4. Signature for generic subflows

A generic subflow has no `type_signature` in its JSON — its type is entirely determined by recursive inference. The engine must:

1. Treat `kind: "subflow"` without a type_signature as "infer recursively"
2. If `sig.kind === "subflow"` and there IS a type_signature, use it as an override/constraint (future extension, not needed for Phase 4)

### A5. Engine Changes

In `typeEngine.ts`:

1. **`infer()` method**: Currently filters to top-level nodes only (line 60: `!n.parentId`). This stays the same — the top-level pass delegates to `inferNode()` for subflow nodes.

2. **`inferNode()` method**: Replace the `case "subflow"` stub (lines 454-457):

```typescript
case "subflow": {
  const stereoName = stereotype.name;

  // ── Repeat: shape-preserving ──────────────────────────
  if (stereoName === "Repeat") {
    if (!inputType) return { nodeId: "", message: "Repeat subflow has no input", severity: "error" } satisfies TypeError;
    // Repeat executes N times → output shape equals input shape
    return { shape: inputType.shape.map(d => ({...d})), dtype: inputType.dtype } satisfies TensorType;
  }

  // ── HorizontalRepeat: concat on last dim ──────────────
  if (stereoName === "HorizontalRepeat") {
    if (!inputType) return { nodeId: "", message: "HorizontalRepeat subflow has no input", severity: "error" } satisfies TypeError;
    const nResolved = this.resolveParamRef("n", params);
    if (nResolved.status !== 'resolved') {
      return { nodeId: "", message: "HorizontalRepeat requires parameter 'n' to be set", severity: "error" } satisfies TypeError;
    }
    const n = nResolved.value;
    const newShape = inputType.shape.map((d, i) => {
      if (i === inputType.shape.length - 1 && d.kind === 'const') {
        return { kind: 'const' as const, value: d.value * n };
      }
      return { ...d };
    });
    return { shape: newShape, dtype: inputType.dtype } satisfies TensorType;
  }

  // ── Generic subflow: recursive inference ────────────
  return this.inferSubflow(nodeId, inputType, diagram, params, env);
}
```

3. **New method `inferSubflow()`**: Private static method that:
   - Collects internal nodes/edges
   - Finds entry/exit nodes
   - Sets up the internal environment with the injected input type
   - Runs topological sort on internal nodes
   - Pattern-matches each internal node's type signature
   - Returns the exit node's output type (or a TypeError)

### A6. Subflow Inference Pseudocode

```typescript
private static inferSubflow(
  subflowNodeId: string,
  externalInputType: TensorType | undefined,
  diagram: Diagram,
  params: Record<string, unknown>,
  env: TypeEnvironment,
): TensorType | TypeError {
  // 1. Collect internal nodes
  const internalNodes = diagram.nodes.filter(n => n.parentId === subflowNodeId);
  if (internalNodes.length === 0) {
    return { nodeId: subflowNodeId, message: "Subflow has no internal nodes", severity: "warning" } satisfies TypeError;
  }

  // 2. Collect internal edges (both ends inside the subflow)
  const internalNodeIds = new Set(internalNodes.map(n => n.id));
  const internalEdges = diagram.edges.filter(
    e => internalNodeIds.has(e.source) && internalNodeIds.has(e.target)
  );

  // 3. Find entry node (internal Input)
  const entryNode = internalNodes.find(n => {
    const stereo = diagram.getStereotype((n.data as any).stereotype);
    return stereo?.isInput;
  });
  if (!entryNode) {
    return { nodeId: subflowNodeId, message: "Subflow has no internal Input node", severity: "error" } satisfies TypeError;
  }

  // 4. Find exit node(s) — internal node with no internal outgoing edges
  const exitNodes = internalNodes.filter(n =>
    !internalEdges.some(e => e.source === n.id)
  );

  // 5. Build local annotations map, seed with external input
  const localAnnotations = new Map<string, NodeTypeAnnotation>();
  if (externalInputType) {
    localAnnotations.set(entryNode.id, {
      nodeId: entryNode.id,
      outputType: externalInputType,
    });
  }

  // 6. Topological sort internal nodes
  const sortedIds = this.topologicalSort(internalNodes, internalEdges);

  // 7. Walk internal nodes (skip Input — already seeded)
  const localEnv: TypeEnvironment = new Map();
  for (const nodeId of sortedIds) {
    if (nodeId === entryNode.id) continue;
    // ... same inference logic as main infer() loop, but using localAnnotations
    // ... collect errors with nodeId prefix "[Subflow] "
  }

  // 8. Return exit type(s)
  // ... return first exit node's output type
}
```

---

## Part B — Repeat Type Signature

Repeat executes its internal subgraph N times sequentially. Each iteration's output becomes the next iteration's input. The shape is **preserved** — the output shape equals the input shape.

No `type_signature` JSON needed — the engine handles it by name (see Part A). The behavior is hardcoded because Repeat is a behavioral stereotype with well-defined semantics, unlike generic subflows whose type depends on their internal graph.

But we should also add a declarative `type_signature` to `Repeat.json` for consistency:

```json
"type_signature": {
  "kind": "subflow",
  "input": [{ "kind": "wildcard" }],
  "output": [{ "kind": "wildcard" }]
}
```

**Constraint**: The subflow's internal exit type must match its entry type. If it doesn't, emit a warning (not error — the user might intentionally change the shape through the subflow).

---

## Part C — HorizontalRepeat Type Signature

HorizontalRepeat executes N parallel copies via `vmap`, then concatenates on the last dimension. Output shape: input shape with last dim multiplied by N.

```json
"type_signature": {
  "kind": "subflow",
  "input": [
    { "kind": "wildcard" }
  ],
  "output": [
    { "kind": "wildcard" }
  ],
  "constraints": {
    "hrepeat": { "n": "params.n" }
  }
}
```

The output wildcard produces the input shape back. The engine then multiplies the last dimension by `n` (already implemented in Part A's `HorizontalRepeat` branch).

**Constraint**: All N copies must receive the same input shape (enforced by `vmap`). No additional validation needed — if the internal subflow is well-typed for one copy, it's well-typed for all.

---

## Part D — TypeSignature Extension

Extend `TypeSignature` in `tensortypes.ts` to support the `hrepeat` constraint:

```typescript
export interface TypeSignature {
  kind: 'module' | 'join' | 'subflow';
  input: ShapePattern | ShapePattern[];
  output: ShapePattern;
  dtype?: { input?: DType; output?: DType };
  constraints?: {
    concat?: { dim: string };
    hrepeat?: { n: string };  // NEW
  };
}
```

---

## Part E — Files to Modify

| File | Change |
|------|--------|
| `front-end/src/conversion/typeEngine.ts` | Replace `case "subflow"` stub with recursive inference |
| `front-end/src/conversion/tensortypes.ts` | Add `hrepeat` constraint to `TypeSignature` |
| `Stereotypes/SubFlows/Repeat.json` | Add `type_signature` |
| `Stereotypes/SubFlows/HorizontalRepeat.json` | Add `type_signature` |
| `front-end/src/__tests__/typeEngine.test.ts` | Add Phase 4 tests (Group 8) |

---

## Part F — Test Plan (Group 8)

### F1. Repeat subflow
```
Test: Input(784) → Subflow(Repeat, iterations=3, internal: ReLU)
  Setup: Create subflow node with Repeat stereotype. Internal graph: Input → ReLU.
         Connect external Input(out_features=784) → subflow.
  Assert:
    - TypeResult.ok === true
    - Subflow output type = [B, 784] (shape-preserving through ReLU × 3 iterations)
```

### F2. HorizontalRepeat subflow
```
Test: Input(128) → Subflow(HorizontalRepeat, n=4, internal: Linear(128→64))
  Setup: Create subflow node with HorizontalRepeat stereotype, n=4.
         Internal graph: Input → Linear(128→64).
         Connect external Input(out_features=128) → subflow.
  Assert:
    - TypeResult.ok === true
    - Subflow output type = [B, 256] (64 × 4 copies concatenated on last dim)
```

### F3. Generic subflow with internal Linear
```
Test: Input(784) → Subflow(internal: Linear(784→256) → ReLU)
  Setup: Create generic subflow node (no behavioral stereotype).
         Internal graph: Input → Linear(in_features=784, out_features=256) → ReLU.
         Connect external Input(out_features=784) → subflow.
  Assert:
    - TypeResult.ok === true
    - Subflow output type = [B, 256]
```

### F4. Generic subflow shape mismatch (error detection)
```
Test: Input(784) → Subflow(internal: Linear(in_features=512, out_features=256))  [MISMATCH]
  Setup: External Input(out_features=784) → subflow with internal Linear(in_features=512)
  Assert:
    - TypeResult.ok === false
    - Error on subflow node, message includes "in_features" or "dimension mismatch"
```

### F5. Nested subflow (recursive)
```
Test: Input(784) → Subflow_A(internal: Subflow_B(internal: ReLU))
  Setup: Two-level nested subflows. Outer contains inner, which contains ReLU.
  Assert:
    - TypeResult.ok === true
    - Output shape = [B, 784] (preserved through both subflows)
```

### F6. HorizontalRepeat with unresolved 'n'
```
Test: Subflow(HorizontalRepeat, n=Undefined)
  Assert:
    - Error: "HorizontalRepeat requires parameter 'n' to be set"
```

---

## Execution Order

1. Extend `TypeSignature` in `tensortypes.ts` (add `hrepeat` constraint)
2. Implement `inferSubflow()` + Replace `case "subflow"` in `typeEngine.ts`
3. Add `type_signature` to `Repeat.json` and `HorizontalRepeat.json`
4. Add Group 8 tests
5. `npx vitest run` + `npm run check`
6. Commit: "feat: Phase 4 — subflow type inference (generic, Repeat, HorizontalRepeat)"
