# Tensor Type System — Architectural Design

**Status**: Design Phase  
**Architect**: NNModelling Architect (DeepSeek v4 Pro)  
**Date**: 2026-06-30

---

## 1. Architectural Analysis

### 1.1 Current Architecture Overview

The NNModelling pipeline consists of these layers:

```
Stereotypes/**/*.json  ──import.meta.glob──► Stereotype[] (stereotype.ts)
                                                      │
                                                      ▼
User drags nodes    ──►  Diagram.nodes/edges ($state.raw)  ──►  FlowCanvas.svelte
                                                      │
                                                      ▼
                                              NNTree (nnTree.ts)
                                          Graph → tree compilation
                                                      │
                                                      ▼
                                              JSON output
                                                      │
                                                      ▼
                                         convert.py (Python)
                                                      │
                                                      ▼
                                         Hydra YAML → main.py
```

Key architectural invariants:

| Component | Responsibility | Data Owned |
|-----------|---------------|------------|
| `Diagram` | Reactive node/edge store | `nodes: Node[]`, `edges: Edge[]`, `stereotypes: Stereotype[]` |
| `Stereotype` | Module/Join/Subflow metadata | `name`, `category`, `pythonClassName`, `parameters`, `view` |
| `NNTree` | Graph → tree compilation | `nodes: Map<string, NNTreeNode>`, `root`, `lossNode` |
| `checkValidConnection` | Target handle uniqueness | Reads `diagram.edges` |

### 1.2 Where Type Inference Fits

The type system is fundamentally a **static analysis pass** over the neural network graph. It must:

1. **Read** node stereotypes (to obtain type signatures)
2. **Read** node parameters (to resolve `in_features`, `out_channels`, etc.)
3. **Traverse** the graph topology (to propagate types forward)
4. **Emit** type information per node (for later use)
5. **Report** type errors (shape mismatches, dtype conflicts)

The natural injection points are:

| Layer | What it provides to the TypeEngine |
|-------|-------------------------------------|
| `Stereotype` | `type_signature` — declarative input/output shape patterns |
| `Diagram` | `nodes`, `edges` — graph topology |
| `NNTree` | Execution order (sequential chains, join ordering) |

### 1.3 Why Not Inside NNTree?

NNTree's job is to **determine execution order** (topology → tree). Type inference needs that order, but mixing the two concerns would:
- Make NNTree untestable in isolation
- Force every compiler change to consider type implications
- Prevent real-time type checking in the editor before compilation

### 1.4 Proposed Integration

The TypeEngine should be an **independent module** that:
- Takes `Diagram` + `Stereotype[]` as input
- Performs constraint-based type inference over the full graph
- Returns a `TypeResult`: either a typed graph or a list of `TypeError`s
- Is consumed by:
  - **Editor** (`checkValidConnection` expanded → `checkValidConnection` + type check, run on every edge add/param change)
  - **NNTree** (optional: can embed type info into NNTree nodes for future pipeline stages)
  - **Unit tests** (standalone verification)

---

## 2. Comparison of Three Architectures

### 2.1 Architecture A — Embedded in NNTree (Tight Coupling)

**Description**: Type inference is called by NNTree during `processNode`. As each node is compiled, its input type is looked up from the predecessor's output, matched against the stereotype's type signature, and the output type is computed and stored in the `NNTreeNode`.

**Data flow**:
```
Diagram → NNTree.processNode(v):
    1. Get predecessor output type
    2. Match against stereotype.type_signature
    3. Compute output type
    4. Store in NNTreeNode
    5. Continue compilation
```

**Pros**:
- Single graph traversal (no duplicate walk)
- Type info naturally available in NNTree output for Python pipeline

**Cons**:
- NNTree becomes a monolith: compilation + type inference intertwined
- Harder to independently test type inference
- No real-time editor feedback without running full compilation
- Adding a new module may require changing NNTree internals
- Violates single-responsibility principle

**Verdict**: ❌ Rejected. Coupling is too high.

---

### 2.2 Architecture B — Post-NNTree Verification (Loose Coupling)

**Description**: NNTree compiles unchanged. A separate `TypeVerifier` pass walks the compiled NNTree and checks types. Errors are reported but do not affect compilation output.

**Data flow**:
```
Diagram → NNTree → NNTree JSON
                          │
                          ▼
                   TypeVerifier.walk(NNTree)
                          │
                          ├── errors: TypeError[]
                          └── types: Map<string, TensorType>
```

**Pros**:
- Complete separation from NNTree
- NNTree unchanged — zero risk of regression
- Easy to test in isolation
- Types available for Python pipeline if embedded in JSON

**Cons**:
- Type errors discovered AFTER compilation, not during editing
- Editor can't give real-time feedback
- Latency: user must trigger compilation to see type errors
- Two separate traversals waste compute (though negligible for DSL scale)

**Verdict**: ✅ Viable but suboptimal. Good for initial implementation; editor integration can come later.

---

### 2.3 Architecture C — Independent Engine, Multi-Point Integration (Recommended)

**Description**: The TypeEngine is a standalone module. It operates directly on `Diagram` data (nodes + edges + stereotypes). It is invoked from multiple call sites:

1. **Editor real-time**: On every edge connection or parameter change, the engine re-infers types for the affected subgraph and reports errors in the sidebar.
2. **Compilation-time**: NNTree optionally calls the engine to attach type information to the tree output.
3. **Test-time**: Unit tests call the engine directly.

**Data flow**:
```
                      ┌─────────────────────────┐
                      │       TypeEngine         │
                      │  (constraint solver)     │
                      │                          │
                      │  infer(diagram, stereo)  │
                      │    → TypeResult          │
                      └──────┬───────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
   FlowCanvas.svelte    NNTree compiler     TypeEngine tests
   (real-time check)    (embed types)       (vitest)
```

**Pros**:
- Clean separation of concerns
- Real-time editor feedback possible
- Incremental: start with post-NNTree verification, evolve to real-time
- NNTree unchanged (types embedded optionally)
- Highly testable — pure function of `(Diagram, Stereotype[]) → TypeResult`
- Adding modules requires only JSON changes (data-driven design)

**Cons**:
- Requires reimplementing topological traversal (already exist in NNTree, but small)
- Slightly more code than Architecture B (but better design)

**Verdict**: ✅ Selected. Best long-term architecture.

---

### 2.4 Summary Table

| Criterion | A (Embedded) | B (Post-NNTree) | C (Independent) |
|-----------|-------------|-----------------|-----------------|
| Separation of concerns | ❌ Low | ✅ High | ✅ High |
| Real-time editor feedback | ❌ No | ❌ No (post-hoc) | ✅ Yes |
| Testability | ❌ Hard | ✅ Easy | ✅ Easy |
| NNTree regression risk | ❌ High | ✅ None | ✅ None |
| Data-driven (no code changes for new modules) | ❌ Mixed | ✅ Yes | ✅ Yes |
| Implementation effort | Medium | Low | Medium |
| Evolvability | ❌ Poor | ✅ Good | ✅ Best |

---

## 3. Justification of Architecture C

Architecture C is selected because:

1. **Separation of concerns**: The TypeEngine is a pure function that takes graph data and returns type information. It has no knowledge of Svelte, the UI, or Python. This makes it:
   - Testable with plain vitest (no DOM, no mocks beyond Diagram)
   - Portable (could be extracted to a shared library if needed)
   - Maintainable (changes to NNTree or the UI don't affect type inference)

2. **Data-driven design**: The engine interprets `type_signature` from stereotypes. Adding `Conv2d` type support requires only modifying `Conv2d.json`. The TypeScript implementation never changes for new modules.

3. **Incremental adoption**: We can start with the simplest integration (post-NNTree verification via Architecture B path) and evolve to real-time editor feedback without changing the engine's core.

4. **Preserves existing architecture**: No changes to NNTree, Diagram, or stereotype loading are required — only additions.

---

## 4. File Structure Changes

### 4.1 New Files

```
front-end/src/conversion/
├── nnTree.ts                 (UNCHANGED)
├── tensortypes.ts            (NEW — Type model interfaces)
├── typeEngine.ts             (NEW — Constraint-based inference engine)
└── typeSignature.ts          (NEW — Signature pattern matching utilities)

front-end/src/__tests__/
├── nnTree.test.ts            (UNCHANGED)
├── utils.test.ts             (UNCHANGED)
└── typeEngine.test.ts        (NEW — Type engine unit tests)
```

### 4.2 Modified Files

| File | Change | Reason |
|------|--------|--------|
| `Stereotypes/Modules/Input.json` | Add `type_signature` | Declare output shape pattern |
| `Stereotypes/Modules/Linear.json` | Add `type_signature` | Declare input/output shape constraints |
| `Stereotypes/Modules/ReLU.json` | Add `type_signature` | Declare shape-preserving behavior |
| `front-end/src/stereotype.ts` | Add optional `type_signature` field to `StereotypeJson` | Parse new JSON field |
| `front-end/src/conversion/nnTree.ts` | Optional: embed type info in NNTreeNode | Future use by Python pipeline |

### 4.3 Files NOT Modified

- `Diagram.svelte.ts` — No changes (engine is external consumer)
- `FlowCanvas.svelte` — No changes in Phase 1 (editor integration is Phase 2+)
- `utils.ts` — No changes (existing `checkValidConnection` remains; type checking is additive, not replacement)
- `Sidebar.svelte` — No changes in Phase 1
- `converted/` — No changes (Python pipeline unaffected)

---

## 5. Type Model — Interfaces

### 5.1 Design Principles

The type model must be:

1. **Declarative**: JSON signatures describe *what* a module expects, not *how* inference works
2. **Symbolic**: Dimensions can be symbolic variables (`B`, `C`, `H`, `W`), not just integers
3. **Parameter-aware**: Dimension values can reference module parameters (`params.in_features`)
4. **Extensible**: Future computed dimensions (Conv2d output size formula, Flatten reshaping) can be added without redesigning the schema

### 5.2 Shape Dimension Representation

A shape dimension is NOT a plain string from a JSON array. It is a structured discriminated union:

```typescript
// front-end/src/conversion/tensortypes.ts

/**
 * The kind of a shape dimension.
 */
export type DimKind = 'const' | 'symbolic' | 'param_ref' | 'wildcard';

/**
 * A single dimension in a tensor shape.
 *
 * - const: a literal integer (e.g., 784, 1, 3)
 * - symbolic: a named dimension variable (e.g., "B", "C", "H", "W")
 * - param_ref: references a module parameter (e.g., "in_features", "out_features")
 * - wildcard: matches zero or more dimensions of any size ("*")
 */
export interface ShapeDimension {
  kind: DimKind;

  /** Present for 'const' dimensions */
  value?: number;

  /** Present for 'symbolic' and 'param_ref' dimensions */
  name?: string;
}

/**
 * A tensor shape: an ordered list of dimensions.
 */
export type TensorShape = ShapeDimension[];

/**
 * Supported dtypes.
 * We track these as strings to remain extensible without enum changes.
 */
export type DType = string;  // "float32", "float64", "int64", "int32", "bool", etc.

/**
 * A fully-resolved tensor type: shape + dtype.
 */
export interface TensorType {
  shape: TensorShape;
  dtype: DType;
}

/**
 * A dimension that appears in a ShapePattern (the declarative signature).
 * This is what stereotype JSON defines — it may contain unreferenced
 * symbolic variables introduced by prefixing with '$'.
 */
export type ShapeDimPattern =
  | { kind: 'const'; value: number }
  | { kind: 'symbolic'; name: string }      // e.g., "$B"
  | { kind: 'param_ref'; name: string }     // e.g., "params.in_features"
  | { kind: 'wildcard' };                   // e.g., "$..."

/**
 * A shape pattern that describes expected input or output shapes.
 * Used in type_signature JSON within stereotypes.
 */
export type ShapePattern = ShapeDimPattern[];
```

### 5.3 Why Not Plain String Arrays?

Consider a JSON array like `["$B", "...", "params.in_features"]`.

Problems:
1. **Ambiguity**: Is `"..."` a wildcard dimension or three literal dots? Is it one wildcard or multiple?
2. **No metadata**: We can't distinguish symbolic dimensions from parameter refs without string inspection
3. **Poor extensibility**: If we later need to express `"conv_output(C, K, S, P)"` as a computed dimension, a flat string is insufficient
4. **Validation fragile**: Must parse strings at runtime to validate, increasing error surface

The discriminated union approach gives us:
- **Type safety**: TypeScript enforces valid dimension kinds at compile time
- **Clarity**: `{ kind: 'wildcard' }` is unambiguous vs `"..."`
- **Extensibility**: Future `{ kind: 'computed', formula: 'conv_output', args: [...] }` fits naturally

### 5.4 Type Signatures

```typescript
// front-end/src/conversion/tensortypes.ts (continued)

/**
 * Describes how a module consumes input tensors and produces output tensors.
 *
 * For a standard Module (single input, single output):
 *   input: ShapePattern     — the expected input shape pattern
 *   output: ShapePattern    — the produced output shape pattern
 *
 * For a Join (multiple inputs, single output):
 *   input: ShapePattern[]   — one pattern per input handle (in-0, in-1, ...)
 *   output: ShapePattern    — the produced output shape pattern
 */
export interface TypeSignature {
  /** The kind of node this signature applies to */
  kind: 'module' | 'join' | 'subflow';

  /** Input shape pattern(s) */
  input: ShapePattern | ShapePattern[];

  /** Output shape pattern */
  output: ShapePattern;

  /** Optional: dtype constraints on input/output (default: no constraint implies float32) */
  dtype?: {
    input?: DType;
    output?: DType;
  };
}
```

### 5.5 Type Environment

```typescript
/**
 * A binding from symbolic dimension names to their resolved values.
 * Populated during type inference as the engine walks the graph.
 *
 * Example: { "B": { kind: 'symbolic', name: 'B' }, "C": { kind: 'const', value: 3 } }
 */
export type TypeEnvironment = Map<string, ShapeDimension>;

/**
 * Maps each node ID to its inferred tensor types.
 *
 * For standard modules:
 *   inputType: TensorType   — type arriving at this node
 *   outputType: TensorType  — type leaving this node
 *
 * For join nodes:
 *   inputTypes: TensorType[]  — one type per input handle
 *   outputType: TensorType    — merged output type
 */
export interface NodeTypeAnnotation {
  nodeId: string;
  inputType?: TensorType;
  inputTypes?: TensorType[];   // for join nodes
  outputType: TensorType;
}
```

### 5.6 Error Model

```typescript
/**
 * Represents a type error discovered during inference.
 */
export interface TypeError {
  /** The node ID where the error was detected */
  nodeId: string;

  /** Human-readable error message */
  message: string;

  /** Severity: 'error' blocks compilation; 'warning' is advisory */
  severity: 'error' | 'warning';
}

/**
 * The result of type inference.
 */
export interface TypeResult {
  /** Whether inference succeeded without errors */
  ok: boolean;

  /** Per-node type annotations (populated even if some nodes have errors) */
  annotations: Map<string, NodeTypeAnnotation>;

  /** All type errors found during inference */
  errors: TypeError[];
}
```

---

## 6. Stereotype Extension — JSON Schema

### 6.1 Input Node

```json
{
  "category": "Input",
  "pythonClassName": "None",
  "view": { "color": "#27b376", "width": 25, "height": 15 },
  "params": {
    "out_features": { "type": "int", "default": "784" }
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
- Input nodes have no input (empty array) — they are sources
- Output shape: `[B, out_features]` where `B` is a symbolic batch dimension and `out_features` comes from the node's parameter
- Output dtype: `float32`

### 6.2 Linear Node

```json
{
  "category": "Layer",
  "pythonClassName": "nn.Linear",
  "view": { "color": "#4779c4", "width": 140, "height": 60 },
  "params": {
    "in_features": { "type": "int", "default": "Undefined", "position": "top" },
    "out_features": { "type": "int", "default": "Undefined", "position": "bottom" },
    "bias": { "type": "bool", "default": "True" },
    "device": { "type": "str", "default": "None" },
    "dtype": { "type": "str", "default": "None" }
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
- Input: `[B, *, in_features]` — batch dimension, arbitrary intermediate dimensions (wildcard), then the feature dimension matching `in_features`
- Output: `[B, *, out_features]` — same batch, same intermediate dims, last dim becomes `out_features`
- Wildcard dimensions are preserved: if input is `[B, 128, 512]`, output is `[B, 128, 256]`
- **Constraint**: The last input dimension must equal `params.in_features`

### 6.3 ReLU Node

```json
{
  "category": "Layer",
  "pythonClassName": "nn.ReLU",
  "view": { "color": "#f4a460", "width": 100, "height": 50 },
  "params": {
    "inplace": { "type": "bool", "default": "False" }
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
- Activation functions are shape-preserving and dtype-preserving
- Wildcard on input captures the entire shape; wildcard on output reproduces it
- **Constraint**: Input and output have identical shapes and dtypes

### 6.4 Notation Rules

| JSON Notation | Meaning | Canonical Form in Code |
|--------------|---------|----------------------|
| `{ "kind": "symbolic", "name": "$B" }` | Introduces/binds a symbolic dimension `B` | `{ kind: 'symbolic', name: 'B' }` |
| `{ "kind": "wildcard" }` | Matches zero or more dims of any size | `{ kind: 'wildcard' }` |
| `{ "kind": "param_ref", "name": "in_features" }` | Resolves to `params.in_features` value | `{ kind: 'param_ref', name: 'in_features' }` |
| `{ "kind": "const", "value": 1 }` | Literal dimension value | `{ kind: 'const', value: 1 }` |

**Design choice**: The `$` prefix in JSON symbolic names distinguishes "I intend to bind a variable" from parameter references. The `$` is stripped during parsing into the canonical `ShapeDimPattern` form.

---

## 7. Formal Type System Definition

### 7.1 Tensor Type

A tensor type \(\tau\) is a pair:

\[
\tau ::= Tensor(\sigma, \delta)
\]

where:
- \(\sigma\) is a tensor shape (a sequence of dimensions)
- \(\delta\) is a tensor dtype

### 7.2 Shape Dimension

A shape dimension \(d\) is one of:

\[
d ::= c \mid x \mid p \mid *
\]

where:
- \(c \in \mathbb{N}\) is a constant dimension (e.g., \(3\), \(784\), \(1\))
- \(x \in \mathcal{X}\) is a symbolic dimension variable (e.g., \(B, C, H, W\)) — these represent unknown-but-binding dimensions
- \(p \in \mathcal{P}\) is a parameter reference (e.g., `in_features`, `out_channels`) — resolved at inference time from the node's parameter values
- \(*\) is the wildcard dimension, matching zero or more arbitrary dimensions

### 7.3 Shape

A shape \(\sigma\) is a finite sequence of dimensions:

\[
\sigma ::= d_1, d_2, \ldots, d_n
\]

Shapes support a special "rest" wildcard pattern `...` that may appear at most once in a shape pattern, matching zero or more consecutive dimensions. For simplicity in Phase 1, we only allow the wildcard to appear once and treat it as matching any suffix of dimensions after a prefix.

### 7.4 Typing Context (Environment)

The typing context \(\Gamma\) is a partial mapping from symbolic dimension names to their resolved values:

\[
\Gamma ::= \{ x_1 \mapsto d_1, x_2 \mapsto d_2, \ldots \}
\]

Additionally, \(\Gamma\) carries the dtype environment and node-to-type mappings.

### 7.5 Typing Judgment

The basic typing judgment is:

\[
\Gamma, P \vdash M : (\tau_{in} \rightarrow \tau_{out})
\]

where:
- \(\Gamma\) is the current type environment
- \(P\) is the set of node parameters (key-value map)
- \(M\) is a module with stereotype containing `type_signature`
- \(\tau_{in}\) is the input tensor type
- \(\tau_{out}\) is the output tensor type

An alternative judgment form for graph-level inference:

\[
\Gamma \vdash G : \Gamma'
\]

meaning: "graph \(G\) is well-typed, producing the extended environment \(\Gamma'\)."

### 7.6 Inference Rules — Phase 1 Modules

#### Input Node

The Input node has no predecessor and produces a shape from its parameter:

\[
\frac{
  \text{stereotype}(v) = \text{Input} \quad
  P = params(v)
}{
  \Gamma \vdash v : Tensor([B, P.\text{out\_features}], \text{float32})
}\]

Where \(B\) is a fresh symbolic dimension variable introduced into \(\Gamma\).

#### Linear Node

Given input \(x\) of type \(Tensor((B, \alpha_1, \ldots, \alpha_k, F), \delta)\):

\[
\frac{
  \Gamma \vdash x : Tensor((B, \alpha_1, \ldots, \alpha_k, F), \delta) \quad
  F = P.\text{in\_features}
}{
  \Gamma \vdash \text{Linear(in\_features, out\_features)}(x) :
  Tensor((B, \alpha_1, \ldots, \alpha_k, P.\text{out\_features}), \delta)
}\]

Where \(\alpha_i\) are intermediate dimensions matched by the wildcard.

Condition: the last dimension of input must equal `P.in_features`. If the constraint is violated, a type error is emitted.

#### ReLU Node

Activation functions are shape-preserving and dtype-preserving:

\[
\frac{
  \Gamma \vdash x : Tensor(\sigma, \delta)
}{
  \Gamma \vdash \text{ReLU}(x) : Tensor(\sigma, \delta)
}\]

### 7.7 Constraint-Based Inference Algorithm

Rather than hardcoding the Linear/ReLU rules as TypeScript conditionals, the TypeEngine implements a **constraint generation + constraint solving** approach:

1. **Constraint Generation**: For each node, read the stereotype's `type_signature` and generate constraints:
   - *Pattern matching*: Input tensor shape must match the declared input pattern
   - *Binding*: Symbolic dimensions in the pattern bind to their matched concrete values
   - *Resolution*: Parameter references resolve to their concrete values
   - *Propagation*: Output pattern, with bound variables substituted, becomes the output type

2. **Constraint Solving**: Walk the graph in topological order. For each node:
   - Unify the actual input type (from predecessor output) with the declared input pattern
   - If unification fails, record a `TypeError`
   - If unification succeeds, apply bindings to the output pattern to produce the output type

3. **Wildcard Semantics**:
   - A wildcard in the input pattern matches any sequence of dimensions
   - Wildcard dimensions are carried forward to the corresponding position in the output pattern
   - This enables operations like `Linear` which act only on the last dimension while preserving all intermediate dimensions

### 7.8 Why Constraint-Based?

Benefits over ad-hoc module-specific checks:

1. **Extensibility**: New modules only need JSON signatures — no TypeScript changes
2. **Uniformity**: All modules go through the same pattern-matching pipeline
3. **Correctness**: Easier to reason about (each constraint is a simple logical condition)
4. **Future optimizations**: Constraint solving can be extended to infer dimension values (e.g., deduce `in_features = 784` from context) or detect redundant constraints

---

## 8. TypeEngine Design

### 8.1 Architecture

The TypeEngine is a **pure function** (no side effects, no UI dependencies):

```
TypeEngine.infer(diagram: Diagram): TypeResult
```

It does NOT modify the diagram. It returns annotations and errors.

### 8.2 Module Structure

```typescript
// front-end/src/conversion/typeEngine.ts

export class TypeEngine {

  /**
   * Run full type inference over a diagram.
   *
   * @param diagram - The Diagram instance (provides nodes, edges, stereotypes)
   * @returns TypeResult with annotations and errors
   */
  static infer(diagram: Diagram): TypeResult;

  /**
   * Run inference on a single node given its input type.
   * Used for real-time checks when a single node's params change.
   *
   * @param nodeId - The node to check
   * @param inputType - The resolved input tensor type (from predecessor)
   * @param stereotype - The node's stereotype (with type_signature)
   * @param params - The node's current parameter values
   * @returns Output tensor type, or a TypeError
   */
  static inferNode(
    inputType: TensorType,
    stereotype: Stereotype,
    params: Record<string, any>,
    env: TypeEnvironment
  ): { outputType: TensorType } | TypeError;
}
```

### 8.3 Core Algorithm — `infer(diagram)`

```
1. Build topological order of nodes (Kahn's algorithm on Diagram nodes/edges)
2. Initialize TypeEnvironment (empty)
3. Initialize annotations Map (empty)
4. Initialize errors array (empty)

5. For each node in topological order:
   a. Get node's stereotype and params
   b. If stereotype has no type_signature:
      - Emit warning: "No type signature for stereotype X"
      - Continue (skip type checking for this node)
   c. Determine input type:
      - If node is Input: inputType = undefined (source node)
      - If node has one predecessor: inputType = predecessor's outputType
      - If node has multiple predecessors (join): inputTypes = [p1.outputType, p2.outputType, ...]
   d. Call patternMatch(node, inputType, stereotype, params, env)
   e. If patternMatch returns TypeError: push to errors, continue
   f. If patternMatch returns outputType:
      - Store annotation: annotations.set(nodeId, { inputType, outputType })
      - Update env with any new symbolic bindings

6. Return TypeResult { ok: errors.length === 0, annotations, errors }
```

### 8.4 Pattern Matching Algorithm — `patternMatch`

```
Input:
  inputType: TensorType   — the actual type arriving at this node
  signature: TypeSignature — from stereotype.type_signature
  params: Record<string, any> — node's resolved parameter values
  env: TypeEnvironment — current symbolic bindings

Output:
  { outputType: TensorType } | TypeError

Algorithm:
1. Parse signature.input as ShapePattern[]
2. Parse signature.output as ShapePattern

3. For each dimension in the input pattern:
   a. Match against the corresponding dimension in inputType.shape:
      - pattern kind = 'const' with value V:
        → input dim must equal V. If not, return TypeError("dimension mismatch: expected V, got X")
      - pattern kind = 'symbolic' with name N:
        → If N is already bound in env: input dim must equal env[N]. If not, TypeError.
        → If N is unbound: bind env[N] = input dim
      - pattern kind = 'param_ref' with name P:
        → Resolve P from params (e.g., params["in_features"] → 512)
        → input dim must equal resolved value. If not, TypeError.
      - pattern kind = 'wildcard':
        → Consume zero or more dimensions from inputType
        → Store consumed dims for later substitution into output

4. For each dimension in the output pattern:
   a. Resolve the dimension using env bindings and captured wildcard dims:
      - 'const' → use literal value
      - 'symbolic' → substitute from env (if unbound, keep as symbolic)
      - 'param_ref' → resolve from params
      - 'wildcard' → substitute captured wildcard dimensions
   b. Build outputType.shape from resolved dims

5. Handle dtype:
   a. If signature.dtype?.input is set:
      → inputType.dtype must match. If not, TypeError.
   b. If signature.dtype?.output is set:
      → outputType.dtype = signature.dtype.output
   c. Otherwise: outputType.dtype = inputType.dtype (propagate)

6. Return { outputType }
```

### 8.5 Edge Cases

| Case | Behavior |
|------|----------|
| Node has no type_signature | Warning emitted; type inference skips this node; downstream nodes with no predecessor type get `Tensor([], 'unknown')` |
| Parameter value is "Undefined" | Parameter reference resolves to a fresh symbolic variable (user hasn't set it yet) |
| dtype is "None" in params | Treated as "any dtype" (matches whatever input provides) |
| Input shape has more dims than pattern | If a wildcard is present, extra dims are consumed by wildcard. Otherwise, TypeError. |
| Input shape has fewer dims than pattern | TypeError ("expected N dimensions, got M") |
| Join node has N inputs | Input pattern is an array of N ShapePatterns; each is matched against corresponding input |

### 8.6 Supported Modules in Phase 1

| Module | Type Signature Behavior | Status |
|--------|------------------------|--------|
| Input | Source: produces `[B, out_features]` | ✅ Implement |
| Linear | Last dim: `in_features` → `out_features`; wildcard preserved | ✅ Implement |
| ReLU | Shape-preserving, dtype-preserving | ✅ Implement |

### 8.7 Modules Marked for Future Phases

For all other stereotypes, the `type_signature` field should be absent. The TypeEngine will emit a warning and skip type checking for that node. This means:

- **Conv2d**: Needs computed output size formula → Phase 2
- **Flatten**: Needs dimension computation (product of wildcard dims) → Phase 2
- **Concat/Addition/MatMul/Einsum/ScaledDotProduct**: Join nodes, need multi-input pattern matching → Phase 3
- **Subflow/Repeat/HorizontalRepeat**: Need recursive type inference → Phase 4
- **BatchNorm/LayerNorm/Dropout**: Shape-preserving (like ReLU) → Phase 2 (trivial)
- **MaxPool2d/AvgPool2d**: Like Conv2d, need computed size → Phase 2
- **Embedding/PositionalEncoding/SequencePool**: Special shapes → Phase 3
- **MultiheadAttention/Transformer**: Complex, multi-input/output → Phase 4

---

## 9. Unit Test Plan (Phase 7)

Test file: `front-end/src/__tests__/typeEngine.test.ts`

### 9.1 Test Style

Follow the existing vitest patterns from `nnTree.test.ts`:
- Use `describe`/`it` blocks
- Use the real `Diagram` class (it works in vitest via Vite plugin)
- Use the existing `node()` and `edge()` factory helpers from `helpers.ts`
- Assert on `TypeResult.ok`, error messages, and shape annotations

### 9.2 Test Cases — Tier 0 (Phase 1)

#### Input → Linear

```
Test: Input(out_features=784) → Linear(in_features=784, out_features=256)

Setup:
  1. Create Diagram
  2. Replace auto-spawned Input node with out_features=784
  3. Add Linear node with in_features=784, out_features=256
  4. Connect Input → Linear

Assert:
  - TypeResult.ok === true
  - LinearNode outputType.shape = [B, 256] (B is symbolic)
  - No errors
```

#### Input → Linear → ReLU

```
Test: Input(784) → Linear(784, 256) → ReLU()

Setup:
  1. Create Diagram
  2. Input(out_features=784) → Linear(in_features=784, out_features=256) → ReLU

Assert:
  - TypeResult.ok === true
  - ReLU outputType.shape = [B, 256] (preserved from Linear)
  - ReLU outputType.dtype = "float32"
  - No errors
```

#### Linear Shape Mismatch

```
Test: Input(784) → Linear(in_features=512, out_features=256)  [MISMATCH]

Setup:
  1. Input with out_features=784
  2. Linear with in_features=512, out_features=256
  3. Connect Input → Linear

Assert:
  - TypeResult.ok === false
  - Errors.length >= 1
  - Error.nodeId === linearNodeId
  - Error.message includes "in_features" or "dimension mismatch" or "expected 512, got 784"
  - Error.severity === 'error'
```

#### Dtype Mismatch

```
Test: Input(dtype=float32) → module expecting float64

Setup:
  1. Create a stereotype JSON for testing or modify Linear's type_signature to expect float64
  2. Input outputs float32 (default)
  3. Connect to module expecting float64

Assert:
  - TypeResult.ok === false
  - Error references dtype mismatch
```

#### Undefined Parameter (Soft Error)

```
Test: Input(784) → Linear(in_features=Undefined, out_features=256)

Setup:
  1. Input with out_features=784
  2. Linear with in_features=Undefined (default), out_features=256
  3. Connect Input → Linear

Assert:
  - TypeResult.ok === true (or false, depending on design decision)
  - If ok: Linear output has symbolic-dim for the last dim (unknown until param set)
  - If not ok: warning about unresolved param_ref
```

#### No Type Signature

```
Test: Module without type_signature (e.g., Fork)

Setup:
  1. Input → Fork (has no type_signature)

Assert:
  - TypeResult.ok === true (skipped, not an error)
  - Warning emitted (info-level, not error)
  - Fork outputType is unknown/any
```

#### Disconnected Node (Graph with Gap)

```
Test: Input → Linear (disconnected from ReLU floating in canvas)

Setup:
  1. Input → Linear (connected)
  2. ReLU placed but NOT connected to anything

Assert:
  - TypeResult.ok === true (disconnected nodes are not traversed)
  - Only 2 annotations (Input + Linear)
```

### 9.3 Test Helpers to Add

Extend `front-end/src/__tests__/helpers.ts` with:

```typescript
/**
 * Create a test Diagram with custom stereotypes (for dtype mismatch testing).
 */
export function createTestDiagram(
  stereotypes?: Partial<StereotypeJson>[]
): Diagram;

/**
 * Assert that a TypeResult is successful and that a node has a specific shape.
 */
export function expectShape(
  result: TypeResult,
  nodeId: string,
  expectedShape: string[]  // e.g., ["$B", "256"]
): void;
```

---

## 10. Implementation Tasks

### 10.1 Task Breakdown

| # | Task | Type | Executor | Description |
|---|------|------|----------|-------------|
| 1 | `tensortypes.ts` — Type model interfaces | Frontend | `@frontend` | Implement all interfaces from Section 5. No logic, only types. |
| 2 | Extend `stereotype.ts` — Parse `type_signature` | Frontend | `@frontend` | Add optional `type_signature` field to `StereotypeJson`, parse it in constructor. |
| 3 | Extend 3 stereotype JSONs — Add `type_signature` | Frontend | `@frontend` | Modify `Input.json`, `Linear.json`, `ReLU.json` with `type_signature` fields. |
| 4 | `typeEngine.ts` — Core inference engine | Frontend | `@frontend` | Implement `TypeEngine` class with `infer()` and `inferNode()` methods. Implement topological sort, pattern matching, constraint solving as described in Section 8. |
| 5 | `typeEngine.test.ts` — Unit tests | Frontend | `@frontend` | Implement all test cases from Section 9. |
| 6 | Report update — Type system formalization | Frontend | `@frontend` | Add Section 7 (formal type system definition) to `analysis/report/ase_report.tex`. |
| 7 | Review | Review | `@reviewer` | Review all implementation against this design document. |

### 10.2 Task Dependencies

```
Task 1 (tensortypes.ts)
    ↓
Task 2 (stereotype.ts extension) ──┐
    ↓                              │
Task 3 (stereotype JSON updates) ──┤
    ↓                              │
Task 4 (typeEngine.ts) ←───────────┘
    ↓
Task 5 (typeEngine.test.ts)
    ↓
Task 6 (report update) — independent, can run in parallel with 4–5
    ↓
Task 7 (review)
```

---

## 11. Remaining TODOs for Future Phases

### 11.1 Phase 2 — Shape-Preserving + Computed Dimensions

- [ ] Add `type_signature` to: BatchNorm1d, BatchNorm2d, LayerNorm, Dropout, Tanh, Sigmoid, Softmax (all shape-preserving, trivial)
- [ ] Conv2d: implement computed dimension formula `conv_output(H, K, S, P, D)` → needs `computed` dimension kind
- [ ] MaxPool2d, AvgPool2d: same computed dimensions as Conv2d
- [ ] Flatten: needs dimension computation (product of wildcard dims)
- [ ] Unsample: needs scaling computation
- [ ] Extend `ShapeDimPattern` with `{ kind: 'computed', formula: string, args: string[] }`

### 11.2 Phase 3 — Join Type Checking

- [ ] Add `type_signature` to all 6 join stereotypes
- [ ] Implement multi-input pattern matching in TypeEngine
- [ ] Concat: dimension alignment (all dims equal except concat dim)
- [ ] MatMul: shape constraints (inner dimensions must match)
- [ ] ScaledDotProduct: Q/K/V shape constraints (batch, heads, seq, d_k)
- [ ] Addition: element-wise, all dims must match
- [ ] Einsum: parse einsum equation and derive input/output shapes
- [ ] MaskedScaledDotProduct: same as ScaledDotProduct + mask shape

### 11.3 Phase 4 — Subflows + Complex Modules

- [ ] Subflow type inference: recursive pass over internal graph
- [ ] Repeat: N copies → shape preserved
- [ ] HorizontalRepeat: N copies → output dim multiplied by N on concat dim
- [ ] MultiheadAttention: decompose into Q/K/V projection + attention + output projection
- [ ] Transformer/TransformerEncoderLayer/TransformerDecoderLayer: full type signatures
- [ ] PositionalEncoding: adds positional dim
- [ ] SequencePool: collapses sequence dim (mean over dim)

### 11.4 Phase 5 — Editor Integration

- [ ] Call TypeEngine from `FlowCanvas.svelte` on edge connect/disconnect
- [ ] Call TypeEngine on parameter change (debounced)
- [ ] Display type errors in Sidebar
- [ ] Display inferred shapes on hover (tooltip on handles)
- [ ] Visual error indicators on nodes (red border on mismatch)

### 11.5 Phase 6 — Python Pipeline Integration

- [ ] Embed type annotations in NNTree JSON output
- [ ] Validate types in `convert.py` (cross-check)
- [ ] Use inferred shapes for automatic `Flatten` insertion (if desired)

### 11.6 Open Design Questions

1. **Should `$` prefix be required in JSON or optional?** Currently required for symbolic dims in JSON to disambiguate from param refs. Could be made implicit based on position.
2. **Should dtype be propagated forward only or also validated backward?** Forward-only in Phase 1; backward inference (e.g., deducing input dtype from loss function) is Phase 4+.
3. **How to handle `device` and `dtype` params that are "None"?** "None" means "defer to framework" — treated as wildcard dtype.
4. **What constitutes a type error vs a warning?** Shape mismatches are errors. Missing type_signature is a warning. Undefined parameters could be either — suggest warning for Phase 1.
5. **Should the TypeEngine support incremental inference (single-node)?** The `inferNode()` static method supports this for real-time checks, but Phase 1 only uses `infer()` for full-graph inference.
