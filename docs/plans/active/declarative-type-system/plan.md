---
id: declarative-type-system
kind: plan
status: draft
updated: 2026-08-16
areas:
  - frontend
  - stereotypes
  - type-system
  - documentation
---

# Declarative tensor type-system redesign

## Goal

Replace the current action-driven tensor inference with one generic,
data-driven type language. A conventional stereotype must be addable by
declaring input groups, an output shape definition, dtype expressions and
constraints, without adding a stereotype/category/name branch to the generic
engine. `EinsumShape` is the sole intentional special shape primitive; its
selection comes from the shape-definition discriminant, never from a
stereotype named `Einsum`.

This initiative is documentation and implementation planning only. No runtime
code or stereotype JSON is changed by this plan.

## Scope

- Introduce the target concepts shown by the redesigned UML: `InputGroup`,
  `ShapeDefinition`, `ComputedShape`, `EinsumShape`, explicit symbolic scope,
  typed expressions and `TypeConstraint`.
- Replace Join and Subflow action switches with generic signature evaluation.
- Migrate all 37 bundled stereotype JSON files and validate them at load time.
- Preserve diagram/NNTree compatibility and current diagnostic/RPC contracts.
- Make variadic arity part of the signature and reflect its bounds in the Join
  editor.
- Preserve the dedicated Einsum equation evaluator behind `EinsumShape`.
- Keep every serialized expression as human-readable DSL source; extend the
  existing parser and keep its typed AST strictly internal.
- Add architectural regression checks that reject dependencies on ordinary
  stereotype names and legacy action fields.

## Non-goals

- Redesign NNTree, Python module execution or the visual graph metamodel beyond
  the narrow changes needed to share subflow entry/exit and ordered-input
  semantics.
- Add multiple tensor outputs to a signature.
- Implement general PyTorch broadcasting unless a migrated signature explicitly
  adopts a generic broadcasting primitive.
- Turn Python parameter strings into executable code or use `eval`/`Function`.
- Preserve a permanent second evaluator for the legacy action schema.

## A. Reverse engineering dell'implementazione corrente

### A.1 Percorso dei dati e ownership

1. `front-end/src/core/StereotypeCore.ts:16-36` types the raw JSON only at
   compile time. `loadFromDirectory()` imports `Stereotypes/**/*.json` as
   `any`, catches loader failures, logs them and continues.
2. `StereotypeCore.parseTypeSignature()` at
   `front-end/src/core/StereotypeCore.ts:118` distinguishes a module pattern
   from Join patterns by testing whether `raw.input[0]` is an array. It strips
   `$` from symbolic names, shallow-copies nested configuration and performs no
   schema or expression validation.
3. `Diagram` loads the stereotypes and recomputes `TypeEngine.infer()` after
   every graph-change event (`front-end/src/Diagram.svelte.ts:41-70`).
4. `TypeEngine.infer()` at
   `front-end/src/conversion/typeEngine.ts:59` topologically visits top-level
   nodes, collects predecessor annotations, delegates to `inferNode()`, and
   recursively reimplements the same traversal for subflows.
5. Conversion is blocked on hard type errors before `NNTree` is constructed
   (`front-end/src/FlowCanvas.svelte:334-349`). Type results are also serialized
   for browser RPC by `front-end/src/conversion/typeDiagnostics.ts`.
6. `NNTree` independently orders Join parents by `targetHandle` and independently
   compiles subflow topology (`front-end/src/conversion/nnTree.ts:17-34` and
   `:141-221`). The two traversals agree on common fixtures but do not share one
   structural scope descriptor.

The browser `DiagramCore` remains the owner of live graph state. The type
refactor must not introduce a second graph in the type subsystem.

### A.2 Modello TypeScript corrente

`front-end/src/conversion/tensortypes.ts` currently defines:

- `DType` as an extensible string (`:50`);
- resolved and pattern dimensions with `const`, `symbolic`, `param_ref`,
  `wildcard`, `computed` and `param_spread` (`:26-32`, `:81-87`);
- `ShapePattern` as an array;
- `TypeSignature` as `kind: module | join | subflow`, a union-shaped `input`, a
  pattern-only `output`, optional literal dtype fields, and optional `join`,
  `subflow` and `advisories` configuration (`:113-198`);
- a single global `TypeEnvironment`, plus separate errors, warnings and
  suggestions in the public result.

These TypeScript types are not a faithful implementation of either UML. In
particular, `JoinConfig` and `SubflowConfig` are implementation workarounds that
encode operation families through `action` strings.

### A.3 Pattern matching and dimensions

`TypeEngine.patternMatch()` (`front-end/src/conversion/typeEngine.ts:1371`)
matches dimensions from left to right:

- fixed dimensions compare exact positive-looking numbers, although positivity
  and integrality are not actually checked at runtime;
- global symbols use the graph-wide map;
- `#`-prefixed symbols use a local key which is filtered before propagation;
- set `param_ref` values must equal the incoming constant; unset values consume
  one dimension and may emit a suggestion; invalid numeric values are errors;
- input-side `computed` merely consumes a dimension and never checks the
  expression;
- one wildcard consumes the maximum dimensions that leave enough for the
  pattern suffix;
- an input `param_spread` consumes N dimensions, where N is the number of parsed
  parameter values, but deliberately does **not** compare those dimensions with
  the parameter values.

`resolvePattern()` (`:1627`) builds outputs. Wildcards replay captured input
dimensions; computed expressions become constants when possible or deferred
`computed` values; output `param_spread` emits the parameter values as N
dimensions.

Current `ParameterSpreadDimension` edge cases must be treated explicitly during
migration:

- an unset or invalid input spread is treated like a greedy wildcard;
- an unset or invalid output spread becomes one symbolic placeholder, so its
  rank no longer corresponds to the unknown list length;
- invalid tuple text is indistinguishable from unset text;
- `parseInt` accepts partial integers and truncates decimals;
- a set input spread checks only arity, while a set output spread emits values.

The first and third behaviors are technical debt, not a sound gradual-typing
contract. The arity-only input behavior is intentional in the supplied UML
description and must remain unless an explicit constraint asks for value
equality.

### A.4 Symbolic scope

The serialized prefixes are the current scope model:

- `$B` is stripped by the loader and stored as `B`; it participates in the
  graph-wide environment.
- `#L` remains prefixed, is made available while one signature output is
  resolved, and is filtered from downstream propagation.

Local bindings are shared across all input patterns of one Join after the
per-input maps are merged. A repeated subflow application creates a new local
map, while globals are inherited. The intent matches `LOCAL`/`GLOBAL`, but the
representation is stringly typed and `resolvePattern()` removes both prefixes
to build the numeric expression environment, allowing name collisions.

### A.5 Expression implementation

`front-end/src/expr/` contains one numeric recursive-descent parser:

- the AST (`types.ts:41-47`) supports numeric literals, symbolic or parameter
  variables, wildcard product, arithmetic, unary minus and calls;
- the parser (`parser.ts:26`) implements precedence for `+ - * / // %`;
- the evaluator (`evaluator.ts:17`) supports `floor`, `ceil`, `abs`, `min` and
  `max` and returns `undefined` for every unresolved variable, unknown function
  or invalid arity;
- parsed strings are cached by source text.

This parser is the foundation of the redesigned surface language: existing
human-readable arithmetic expressions remain valid source. It must be extended
with the missing constructs and followed by a typed compilation step; merely
growing the current untyped `ExprNode -> number | undefined` evaluator would
hide too many category errors. The parsed AST is an internal representation,
never stereotype JSON.

Advisories do not use this parser generally. `evaluateAdvisory()`
(`front-end/src/conversion/typeEngine.ts:2040`) first runs a hardcoded
`kernel_size`/`H`/`W`/`L` algorithm and otherwise applies one regular expression
for simple comparisons. The declared boolean text is therefore not the actual
authority.

### A.6 Join inference

The top-level and subflow traversals use `sig.kind === "join"` to collect
ordered inputs. `inferNode()` then:

- requires the number of concrete inputs to equal the number of input patterns;
- dispatches Einsum before pattern matching when `join.action === "einsum"`;
- matches each input separately and merges symbol bindings;
- silently applies one blanket rule: wildcard captures of every non-Concat Join
  must be identical;
- dispatches Concat when `join.action === "concat"`, parses/normalizes `dim`,
  validates ranks and non-axis dimensions, and calls
  `resolveConcatOutput()` (`front-end/src/conversion/typeEngine.ts:1283`);
- resolves every other output as a `ShapePattern` and defaults output dtype to
  the first input dtype.

`element_wise` and `matmul` action values are currently semantic labels only;
the engine has no branch for them. Addition obtains its behavior from the
blanket wildcard-capture equality rule, not from a declared constraint.

The editor is more variadic than the type system. `JoinNode.svelte:34-78` lets a
user add any number of handles but hardcodes a minimum of two. `DiagramCore`
creates every Join with `inputsCount = 2` (`front-end/src/core/DiagramCore.ts:
271-293`). The current signature then rejects anything other than the two
patterns present in most Join JSON files.

### A.7 Subflow inference

`TypeEngine.inferSubflow()` (`front-end/src/conversion/typeEngine.ts:946`)
collects direct children, identifies one entry, requires one structural exit,
topologically evaluates internal nodes and returns the exit type. Anonymous
subflow containers without a stereotype signature are supported by a separate
`hasInternalNodes` branch.

Typed subflows dispatch on `subflow.action` (`:716-916`):

- `identity` evaluates children only for side effects and returns the input;
- `infer` returns one generic subflow application;
- `repeat` resolves a configured/default iteration parameter and repeatedly
  calls `inferSubflow`;
- `infer_then_transform` applies the subflow once and contains a dedicated
  `last_dim.multiply` transform.

Repeat now composes shape-changing subflows and detects an incompatible later
iteration, but the semantics still live in a dedicated action branch. Reused
internal node IDs also force annotation-preservation logic specific to repeated
evaluation.

### A.8 Test baseline and test-quality findings

The current frontend suite passes with:

```bash
pnpm --dir front-end test
```

Existing tests are valuable characterization but are not sufficient acceptance
for the redesign:

- Addition and Concat cover two inputs only;
- the MatMul mismatch fixture does not construct the matrix shapes named in its
  title and has no positive general-batch case;
- several Conv/Pool tests exercise `inferConcrete()` rather than a complete
  graph;
- invalid `param_spread` text is asserted to succeed as gradual typing;
- old comments still say Einsum has no signature;
- no focused test proves explicit `LOCAL` versus `GLOBAL` scope;
- no loader test rejects an invalid expression before inference.

### A.9 Matrice dei 37 stereotype esistenti

| Stereotype JSON | Contratto corrente | Rappresentazione target | Gap rilevato prima della migrazione |
| --- | --- | --- | --- |
| `Joins/Addition` | Due wildcard, output del primo capture | gruppo `2..*`, pattern, vincolo `allEqual(shape)` | oggi non è variadico e l'uguaglianza è implicita nel motore |
| `Joins/Concat` | Due wildcard + action Concat | gruppo `2..*`, constraint generali, `ComputedShape` | branch completo hardcoded; dtype implicito |
| `Joins/Einsum` | Due wildcard + action/equation param | gruppo `1..*`, `EinsumShape` riferito al parametro | arità UI minima 2; specialità selezionata dall'action |
| `Joins/MatMul` | Due pattern distinti; action non usata | due gruppi `1..1`, pattern e constraint batch dichiarato | il test corrente non prova il caso positivo; broadcasting non modellato |
| `Joins/ScaledDotProduct` | Q/K pattern, action non usata | due gruppi `1..1`, pattern, dtype esplicito | `d_model` non è correlato a D |
| `Joins/MaskedScaledDotProduct` | come ScaledDotProduct | come sopra | come sopra |
| `Modules/AvgPool2d` | pattern 4D + dimensioni calcolate | pattern + `ComputedDimension` + constraint | tuple per asse, `stride=None` e `ceil_mode` incompleti |
| `Modules/BCELoss` | `[B,*] -> [B]` concettuale | pattern + dtype | astrazione intenzionale: il runtime continua a trattare Loss come terminale |
| `Modules/BCEWithLogitsLoss` | `[B,*] -> [B]` concettuale | pattern + dtype | stessa astrazione Loss |
| `Modules/BatchNorm1d` | wildcard identity | pattern/constraint + identity output | non verifica rank ammessi né `num_features` |
| `Modules/BatchNorm2d` | wildcard identity | pattern 4D + constraint | non verifica rank né canali |
| `Modules/Conv1d` | pattern + formula scalare | pattern + `ComputedDimension` + constraint | tuple/string padding e gruppi non completamente modellati |
| `Modules/Conv2d` | pattern + formula scalare | pattern + dimensioni calcolate per asse | tuple/string padding, gruppi e condizioni non completi |
| `Modules/CrossEntropyLoss` | `[B,C] -> [B]` concettuale | pattern + dtype | target e forme higher-rank non appartengono al grafo tipato corrente |
| `Modules/Dropout` | wildcard identity + advisory | pattern + warning constraint | advisory `p > 0.5` usa un evaluator separato |
| `Modules/Embedding` | `[B,L] -> [B,L,E]` | pattern + dtype | PyTorch accetta rank arbitrario di indici; contratto DSL più stretto |
| `Modules/Flatten` | conserva B e moltiplica tutto il resto | `ComputedShape` con slice/product/splice | ignora `start_dim` e `end_dim` |
| `Modules/Fork` | wildcard identity | pattern identity | completo per il contratto strutturale corrente |
| `Modules/Input` | `B` globale + output parameter spread | zero gruppi + output pattern | spread invalido/unset ambiguo |
| `Modules/LayerNorm` | wildcard identity | pattern + constraint sui trailing dims | `normalized_shape` non verificato |
| `Modules/Linear` | B, wildcard intermedio, parametri in/out | gruppo `1..1` + pattern | sostanzialmente rappresentabile; parametro unset va legato coerentemente |
| `Modules/MSELoss` | `[B,*] -> [B]` concettuale | pattern + dtype | stessa astrazione Loss |
| `Modules/MaxPool2d` | formula senza semantica completa | pattern + dimensioni calcolate + constraint | tuple, `dilation` e `ceil_mode` incompleti |
| `Modules/MultiheadAttention` | unary `[B,L,E] -> [B,L,E]` | contratto dichiarato + constraint | API PyTorch è multi-arg/tuple e `batch_first` non è riflesso; serve scelta runtime |
| `Modules/PositionalEncoding` | identity 3D | pattern + constraint | non verifica `D=d_model` né `L<=max_len` |
| `Modules/ReLU` | wildcard identity | pattern identity | completo |
| `Modules/SequencePool` | `[B,*,D] -> [B,D]` | `ComputedShape` con rimozione asse condizionale | `dim` arbitrario e pass-through rank <= 2 non sono modellati fedelmente |
| `Modules/Sigmoid` | wildcard identity | pattern identity | completo |
| `Modules/Softmax` | wildcard identity + float32 | pattern/dtype + axis constraint | `dim` non validato |
| `Modules/Tanh` | wildcard identity | pattern identity | completo |
| `Modules/Transformer` | unary shape-preserving | contratto dichiarato + constraint | `nn.Transformer` richiede src/tgt; il contratto runtime va deciso |
| `Modules/TransformerDecoderLayer` | unary shape-preserving | uno o più gruppi secondo adapter runtime | l'API reale richiede memoria separata |
| `Modules/TransformerEncoderLayer` | unary shape-preserving | pattern + constraint | `batch_first`, `d_model` e divisibilità `nhead` non completamente dichiarati |
| `Modules/Unflatten` | `[B,*] -> [B,param_spread]` | `ComputedShape` splice + product constraint | ignora `dim`, dimensioni circostanti e prodotto |
| `Modules/Unsample` | H/W moltiplicati per `scale_factor` | pattern + dimensioni calcolate/conditional | ignora `size`, tuple e parte delle regole di modalità |
| `SubFlows/HorizontalRepeat` | `infer_then_transform/last_dim.multiply` | `apply` + `replace` in `ComputedShape` | semantica hardcoded e rank-0 non definito |
| `SubFlows/Repeat` | action `repeat` | `iterate(apply(...))` in `ComputedShape` | semantica hardcoded; annotazioni di iterazioni riusano gli stessi node ID |

The target language can express the current declared contracts. It cannot by
itself resolve the highlighted mismatch between several JSON declarations and
their Python APIs; those are explicit migration decisions, not reasons to add
new engine branches.

## B. Inventario dell'hardcoding

| File / funzione | Comportamento | Classificazione | Sostituzione target |
| --- | --- | --- | --- |
| `tensortypes.ts:113-157` | `SubflowConfig` and `JoinConfig` action vocabularies | stereotype-specific semantics | remove; use `ShapeDefinition` and typed expressions |
| `typeEngine.ts:180,1174` | `stereotype.isInput` changes inference path | structural legacy in the type engine | zero input groups plus a graph-supplied subflow boundary |
| `typeEngine.ts:183,1176` | `sig.kind === "join"` changes collection | legacy limitation | always collect ordered inputs; bind `InputGroup`s |
| `typeEngine.ts:491` | action-based Einsum short circuit and default `expr` parameter | intentional primitive selected incorrectly | dispatch only on `EinsumShape`, which explicitly references its parameter |
| `typeEngine.ts:507-515` | exact pattern/input count | legacy limitation | general group lower/upper allocation |
| `typeEngine.ts:546-574` | all non-Concat wildcard captures must match | undeclared Join semantics | `TypeConstraint` on the relevant input group |
| `typeEngine.ts:601-688` | Concat axis parsing, rank and dimension validation | stereotype-specific semantics | `ConstraintExpression` + `ComputedShape` |
| `typeEngine.ts:1283` | `resolveConcatOutput()` | stereotype-specific semantics | `replace(shape(first), axis, sum(map(...)))` |
| `typeEngine.ts:716-916` | identity/infer/repeat/infer-then-transform switch | stereotype-specific semantics | `apply` and `iterate` expression primitives |
| `typeEngine.ts:799-817` | default parameter name `iterations`, Repeat-specific validation text | stereotype-specific semantics | explicit parameter refs and generic constraints |
| `typeEngine.ts:871-894` | `last_dim.multiply` transform | stereotype-specific semantics | generic `dimAt`, arithmetic and `replace` |
| `typeEngine.ts:434,692` | output dtype defaults to input/first input | undeclared semantics | required `toDType`; explicit `fromDType` when input validation is desired |
| `typeEngine.ts:2040-2103` | `kernel_size` and H/W/L advisory strategies | stereotype/parameter-specific semantics | warning-severity `TypeConstraint` evaluated by the common boolean language |
| `typeEngine.ts:1379-1387` | at most one wildcard | general language limitation | retain as a validated v2 restriction until multiple-wildcard allocation is specified |
| `typeEngine.ts:1531-1545` | input computed dim only consumes a slot | soundness bug | evaluate/match it or reject computed input patterns at schema compile time |
| `typeEngine.ts:1973-2002` | tuple parser conflates invalid/unset and uses `parseInt` | technical debt | typed parameter normalization with structured failure |
| `typeEngine.ts:1674-1704` | malformed output expression logs and becomes deferred | technical debt | reject at stereotype load with path/source diagnostics |
| `typeEngine.ts:2187-2202` | all deferred computed dimensions compare equal | soundness bug | structural symbolic-expression equality or an unresolved result |
| `StereotypeCore.ts:118-143` | array-shape heuristic, prefix rewrite, shallow clone | technical debt | runtime decoder/compiler to immutable compiled signatures |
| `JoinNode.svelte:34-78` | minimum two, unbounded maximum, no signature link | UI legacy | derive lower/upper/default controls from compiled input groups |
| `DiagramCore.ts:271-293` | every Join starts with two inputs | UI legacy | signature-derived minimum/default; validate imported counts |
| `nnTree.ts:17-34` | target-handle ordering | legitimate graph primitive | retain/share with graph typing context |
| `nnTree.ts:42-48,258-260` | exact `Input`/`Fork` names | adjacent compiler hardcoding | reserved structural contract, outside this type-language refactor; do not copy into generic inference |
| `StereotypeCore` category flags and Browser RPC routing | select visual node kind | legitimate editor structure | retain outside generic type evaluation |

Error strings may include a stereotype display name. That is diagnostic
metadata, not semantic hardcoding, provided no decision branches on it.

## C. Mapping vecchio UML -> nuovo UML -> codice

### C.1 Differenze concettuali

The old UML attaches ordered input `ShapePattern`s directly to
`TypeSignature` and requires one output `ShapePattern`. It can describe fixed
arity and dimension-wise reconstruction, but not input multiplicity, whole
shape transforms or generic validation. The current code filled those holes
with `kind`, Join/Subflow actions and advisory strategies.

The new UML changes the language in three essential ways:

1. arity is a declarative property of `InputGroup`, separate from the shape
   matched by each occurrence;
2. output computation is abstracted behind `ShapeDefinition`, so an output can
   be a pattern, a whole-shape expression or the intentional Einsum primitive;
3. validation and dtype transformation are part of the signature rather than
   implicit engine policy.

`ShapePattern` remains the ordinary path. Conv/Pool formulas remain
`ComputedDimension`s because only individual dimensions change. Concat,
Flatten, SequencePool, Unflatten and subflow composition require
`ComputedShape` because their structure or rank is selected/transformed as a
whole.

### C.2 Target representation

| New concept | Meaning / replaces | Target implementation | JSON representation |
| --- | --- | --- | --- |
| `TypeSignature` | one complete tensor contract; replaces `kind`, `join`, `subflow`, `advisories` | immutable `CompiledTypeSignature` in `front-end/src/type-system/model.ts` | `version`, `inputs`, `output`, `from_dtype`, `to_dtype`, `constraints` |
| `InputGroup` | ordered repetition bounds for one pattern | `{ lower, upper, pattern, label? }` plus a deterministic binder | `upper: null` means unbounded; `label` is optional diagnostic metadata |
| `ShapeDefinition` | output strategy | discriminated union | `kind: pattern | computed_shape | einsum` |
| `ShapePattern` | ordered dimension pattern | generic matcher/resolver | `{ kind: "pattern", dims: [...] }` |
| `ComputedShape` | whole-shape computation | parsed and typed `ShapeExpression` evaluation | `{ kind: "computed_shape", expr: "replace(shape(input(0, 0)), ...)" }` |
| `EinsumShape` | equation DSL primitive | cleaned current equation evaluator | `{ kind: "einsum", equation: { parameter: "expr" } }` |
| `FixedDimension` | one literal dimension | current `const` leaf, with domain validation | `{ kind: "const", value: 64 }` |
| `WildcardDimension` | zero-or-more dimension capture | current matcher, one per pattern initially | `{ kind: "wildcard" }` |
| `SymbolicDimension` | one unification variable with explicit scope | symbol key `{scope,name}` instead of prefixes | `{ kind: "symbolic", name: "B", scope: "global" }` |
| `ParameterDimension` | a symbol associated with a parameter | local binding keyed by parameter identity; numeric value wins | `{ kind: "param_ref", name: "in_features" }` |
| `ParameterSpreadDimension` | parameter-list arity/value expansion | named sequence handling, distinct unset/invalid states | `{ kind: "param_spread", name: "out_features" }` |
| `ComputedDimension` | one dimension expression | parsed and typed dimension evaluator | `{ kind: "computed", expr: "floor(($H + 2 * param.padding - 1) / param.stride + 1)" }` |
| `TypeConstraint` | generic validation or advisory | common boolean evaluator | `{ condition: "param.kernel_size <= $H", message?, severity?, category? }` |
| `DTypeExpression` | explicit input expectation/output dtype | common typed expression evaluator | human-readable dtype literal/reference such as `"dtype(input(0, 0))"` |

The leaf `kind` names can remain close to the current JSON to reduce churn; the
conceptual hierarchy lives in the discriminated union and its evaluator.

### C.3 Necessary, general extensions to the UML

The code exposes four concepts that the new diagram does not fully capture:

1. **Diagnostic severity.** Existing advisories are non-fatal and categorized.
   If `TypeConstraint` has only condition/message, migration either turns
   warnings into errors or keeps a second advisory mechanism. The recommended
   extension is optional `severity` (default `ERROR`) and optional diagnostic
   `category`, while reusing exactly the same `ConstraintExpression`.
2. **Input labels.** MatMul and attention diagnostics currently use A/B and Q/K.
   Add optional non-semantic `label` to `InputGroup`.
3. **Anonymous subflows.** The UML attaches a signature through a stereotype,
   but `addSubGraph()` can create a container without one. The recommended
   migration assigns a generic Subflow stereotype/signature to new containers
   and normalizes legacy anonymous containers on import.
4. **Variadic allocation.** Multiple variable-width ordered groups can have
   ambiguous partitions. Version 2 should accept at most one non-fixed group
   unless the bounds make the allocation unique. This covers every bundled
   stereotype and avoids speculative backtracking.

There is also an implicit wildcard-source question. An output pattern wildcard
currently replays the first input's capture. Version 2 should state this rule
explicitly: output-pattern wildcard capture comes from the first occurrence of
the first input group. Signatures needing another source must use
`ComputedShape`. This covers Addition and the current MatMul contract without
adding a stereotype-specific rule.

### C.4 Illustrative serialized signature

Expressions are human-readable source strings in JSON. The loader parses and
type-checks them once, producing an immutable internal AST that is never
serialized. A compact Concat sketch is:

```json
{
  "type_signature": {
    "version": 2,
    "inputs": [
      {
        "lower": 2,
        "upper": null,
        "label": "input",
        "pattern": { "kind": "pattern", "dims": [{ "kind": "wildcard" }] }
      }
    ],
    "output": {
      "kind": "computed_shape",
      "expr": "let first = input(0, 0) in let a = axis(param.dim, rank(first)) in replace(shape(first), a, sum(map(inputs(0), x => dim(x, a))))"
    },
    "constraints": [
      {
        "condition": "let first = input(0, 0) in let a = axis(param.dim, rank(first)) in all(inputs(0), x => rank(x) == rank(first) and remove(shape(x), a) == remove(shape(first), a))",
        "message": "Concat inputs must match outside the selected axis"
      }
    ],
    "from_dtype": "dtype(input(0, 0))",
    "to_dtype": "dtype(input(0, 0))"
  }
}
```

The exact property spelling is frozen by T01 and the grammar by T02. The
important contract is that authors write a small safe language, the operators
are generic (`map`, `sum`, `remove`, `replace`), and no `concat` operator
exists.

## D. Design delle expression language

### D.1 One readable surface language, one internal typed AST

Use one human-readable expression language, evolved from `front-end/src/expr/`,
and one internal expression framework with statically checked result kinds:

- `DimensionExpression -> DimensionValue`;
- `ShapeExpression -> TensorShape`;
- `ConstraintExpression -> boolean/validation`;
- `DTypeExpression -> DType`.

The serialized values of `DimensionExpression`, `ShapeExpression`,
`ConstraintExpression` and `DTypeExpression` are strings. One tokenizer and
recursive-descent parser produces a shared source AST; a type checker compiles
that AST under the expected result category and rejects an ill-typed
declaration before the stereotype is usable. Runtime evaluation returns a
structured outcome (`value`, `deferred`, or `error`), never bare `undefined`.

The surface grammar deliberately remains small:

```text
expr       := letExpr | lambdaExpr | logicalExpr
letExpr    := "let" IDENT "=" expr "in" expr
lambdaExpr := IDENT "=>" expr
primary    := literal | "$" IDENT | "param." IDENT
            | IDENT "(" arguments? ")" | "[" arguments? "]"
```

`logicalExpr` extends the current arithmetic precedence with `== != < <= > >=`,
`and`, `or` and `not`. Literals cover numbers, booleans, strings and shape/list
literals; a known bare dtype token such as `float32` is valid when the expected
result is `DType`. `$H` remains the readable symbolic reference syntax; the
matching pattern declares whether `H` is local or global. A signature may not
declare the same symbol name in both scopes, so source lookup stays unambiguous.
Canonical parameter references use `param.name`; the migration compiler may
temporarily accept a bare identifier when it uniquely names a declared
parameter. Current arithmetic, math calls and `$*` wildcard-product syntax
remain source-compatible.

This is a safe DSL, not JavaScript: there is no property access other than the
closed `param.name` form, no mutation, loops, reflection, I/O or host function
calls. Lambdas are only accepted as arguments to the closed collection and
iteration primitives. Four parsers are unnecessary; expected result category
is a compile-time context.

### D.2 Minimal primitive set

| Family | General primitives required by bundled stereotypes |
| --- | --- |
| references | `param.name`, `$symbol`, `input(group,index)`, `inputs(group)`, bound collection variable |
| tensor projection | `shape`, `dtype`, `rank`, `dim`, `axis` |
| arithmetic | `+ - * / // %`, `floor`, `ceil`, `abs`, `min`, `max`, `product` |
| parameter values | scalar/list normalization, indexed item with scalar broadcasting, `coalesce` |
| shape construction | shape/list literal, `slice`, `remove`, `replace`, `splice` |
| collections | `map`, `sum`, `all`, `all_equal` |
| boolean | equality, ordered comparisons, `and`, `or`, `not`, `is_integer`, membership/range checks |
| control | typed `if`, `coalesce` |
| subflow | `apply` current internal graph once; `iterate` a typed step N times |

`broadcast_shape` may be introduced later as a general tensor primitive if the
MatMul contract is upgraded to PyTorch broadcasting. It is not required to
preserve the current strict-equal batch-prefix contract.

There must be no primitives named after Concat, Addition, Repeat or
HorizontalRepeat.

### D.3 Evaluation context and scoping

The evaluator context contains only generic capabilities:

```text
inputs[group][occurrence] : TensorType
parameters               : normalized values or unset/invalid status
localSymbols             : bindings for this signature application
globalSymbols            : bindings for this root inference
wildcardCaptures         : per group/occurrence/pattern slot
applySubflow(type, trace) : TensorType | diagnostic
trace                     : node, constraint path, input group, iteration
```

Local scope is recreated for every signature application, including every
iteration of `iterate`. Global scope is inherited by nested and repeated
applications. Two occurrences of the same symbol in one scope unify. The key
is a structured `{ scope, name }`, not a prefixed string.

For `ParameterDimension`, a usable numeric parameter produces that dimension.
When unset on input, the matched input dimension becomes a local parameter
binding and may produce a suggestion; later occurrences in the same signature
reuse it. Invalid values are errors. This fixes the current `?param` placeholder
without mutating node parameters automatically.

Recommended v2 `ParameterSpreadDimension` behavior is:

- set list: input consumes exactly N dimensions without comparing values;
  output emits the N parameter values;
- unset input: bind a named dimension sequence from the deterministically
  matched span; output in the same application may reuse that sequence;
- unset output without a bound sequence: remain a deferred sequence, not one
  fake dimension;
- invalid list: hard error.

This is a deliberate cleanup of current invalid/unset conflation and must be
approved before T01 is marked ready.

### D.4 Generic expression sketches

- **Addition**: one `2..*` input group; ordinary output pattern replays the
  first capture; constraint
  `all(inputs(0), x => shape(x) == shape(input(0, 0)))`.
- **Concat**: use the readable expressions shown in C.4: constraints validate
  axis/rank and non-axis shape equality; the output replaces the first input's
  axis with the sum of that dimension across the variadic group.
- **HorizontalRepeat**: `let t = apply(input(0, 0)) in replace(shape(t), -1,
  dim(t, -1) * param.n)`; dtype is `dtype(t)`;
  constraints require `n` integer >= 1 and output rank >= 1.
- **Repeat**: `shape(iterate(param.iterations, input(0, 0), x => apply(x)))`;
  dtype projects from the same final tensor. Every application
  performs normal input matching, so incompatibility on iteration k is a
  regular nested diagnostic with `iteration=k`.
- **Einsum**: `EinsumShape` reads its declared equation parameter and invokes
  the dedicated equation evaluator. No stereotype name is supplied to select
  behavior.

### D.5 Dtype semantics

`fromDType` is evaluated once and is the expected logical input dtype for all
bound inputs. Mismatch retains the current warning behavior unless a hard
`TypeConstraint` says otherwise. `toDType` is required for v2 signatures and
must be explicit:

- sources use a literal;
- shape-preserving unary modules use `dtype(input(0, 0))`;
- current Joins explicitly select `dtype(input(0, 0))` and may add an
  all-equal dtype constraint;
- Embedding uses literal `int64 -> float32`.

This removes the hidden “first input wins” rule. If future promotion is needed,
add one general `promote_dtype` primitive and use it declaratively.

### D.6 Parsing, validation and errors

Validation occurs in two stages:

1. loader/schema compilation: structural fields, bounds and non-empty expression
   source; then tokenize, parse, resolve references, validate operator arity and
   type-check the expression's required result category;
2. inference: concrete/deferred values, group arity, pattern match, constraints
   and subflow application.

Loader errors include stereotype path, JSON pointer, source span, operator and
expected/actual type. Invalid bundled stereotypes fail the validation
test and are not silently omitted. Inference diagnostics retain `nodeId` and
public errors/warnings/suggestions, and add structured context internally for
group occurrence, dimension, constraint and repeat iteration.

## E. Piano di migrazione

The implementation is incremental without a production feature flag. T01-T07
build and validate v2 against isolated fixtures while the current engine
remains the only production path. T08 atomically migrates bundled data and
switches production to one evaluator, deleting the action branches in the same
task. No release contains two selectable semantics.

### E.1 Task graph

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [T01](tasks/T01-language-contract-and-schema.md) | `architecture` | — | — | `front-end/src/type-system/model.ts`, `schema.ts`, `parameterValues.ts`, focused tests | Frozen v2 model and strict compiler |
| [T02](tasks/T02-typed-expression-core.md) | `frontend` | `T01` | — | existing `front-end/src/expr/`, schema integration, focused tests | Readable DSL parser, typed internal AST and evaluator |
| [T03](tasks/T03-generic-signature-evaluator.md) | `frontend` | `T01`, `T02` | — | generic matcher/evaluator files and tests | Patterns, groups, constraints, dtype, computed/Einsum output work without a graph |
| [T04](tasks/T04-subflow-application.md) | `architecture` | `T03` | — | shared scope graph, subflow evaluator, NNTree alignment tests | Generic `apply`/`iterate` use runtime-consistent topology |
| [T05](tasks/T05-module-signature-migration.md) | `frontend` | `T03` | `T06`, `T07` | `Stereotypes/Modules/`, module signature tests | All module/loss/source signatures compile as v2 |
| [T06](tasks/T06-join-signature-migration.md) | `frontend` | `T03` | `T05`, `T07` | `Stereotypes/Joins/`, Join signature tests | Addition/Concat/MatMul/attention/Einsum are declarative |
| [T07](tasks/T07-subflow-signature-migration.md) | `frontend` | `T04` | `T05`, `T06` | `Stereotypes/SubFlows/`, generic Subflow declaration, subflow tests | Normal/Horizontal/Repeat typing uses shape expressions |
| [T08](tasks/T08-type-engine-cutover.md) | `integration` | `T04`, `T05`, `T06`, `T07` | — | current loader/engine/model bridge and graph tests | Production uses only the v2 evaluator; legacy actions are removed |
| [T09](tasks/T09-input-group-editor-integration.md) | `frontend` | `T08` | `T10` | Join UI/core/RPC arity paths and tests | Editor respects signature lower/upper bounds |
| [T10](tasks/T10-legacy-cleanup-and-architecture-guards.md) | `review` | `T08` | `T09` | legacy evaluator cleanup, loader/architecture tests | No action/name semantic path can regress silently |
| [T11](tasks/T11-documentation-and-final-verification.md) | `documentation` | `T09`, `T10` | — | current knowledge, public docs, agent guidance, evidence | Contracts are current and end-to-end behavior is verified |

Parallel tasks have non-overlapping write scopes. T08 owns integration into the
existing monolithic `typeEngine.test.ts`; migration tasks add separate focused
test files to avoid conflicts.

### E.2 Fasi, modifiche e criteri di completamento

#### Phase 1 / T01 - language contract and loader schema

- Create `front-end/src/type-system/model.ts`, `schema.ts` and
  `parameterValues.ts`.
- Define serialized and compiled v2 unions, group allocation restrictions,
  explicit scope, structured loader errors and normalized parameter status.
- Add schema tests for every dimension kind, bounds, missing structural
  parameters, invalid scope, empty/non-string expression source and immutable
  decoded data. Syntax and result typing belong to T02.
- Do not modify production `StereotypeCore` yet.
- Completion: every structurally valid v2 fixture decodes; every structurally
  malformed fixture fails with path-specific diagnostics; the four UML
  extensions are frozen.

#### Phase 2 / T02 - human-readable expression infrastructure

- Evolve the existing tokenizer/parser/types/evaluator in
  `front-end/src/expr/`; do not introduce a second parser or serialized AST.
- Preserve current arithmetic, math functions and `$*`; add the small source
  grammar for `let`, restricted lambdas, parameter/input references, shapes,
  collections, booleans, dtype and subflow callbacks.
- Add a type-checking compilation pass from source AST to internal typed AST and
  connect it to the T01 schema compiler.
- Add value/deferred/error outcomes and expression-path traces.
- Completion: Dimension, Shape, Constraint and DType expressions are rejected
  at load time on syntax/wrong result type and all generic primitives have
  focused unit coverage.

#### Phase 3 / T03 - generic signature evaluator

- Create group binding, pattern matching, output resolution, constraint and
  Einsum-shape modules under `front-end/src/type-system/`.
- Implement explicit local/global environments and corrected parameter/spread
  semantics.
- Move/clean the current Einsum equation algorithm without passing a stereotype
  name for dispatch.
- Add tests for ordinary pattern layers, all dimension kinds, fixed/variadic
  groups, Addition, MatMul, Concat, ComputedShape, constraints and dtypes using
  synthetic signatures.
- Completion: the evaluator API accepts only compiled signatures, input types,
  normalized parameters and generic capabilities; it cannot receive a
  `StereotypeCore`.

#### Phase 4 / T04 - generic subflow application

- Create a shared scope-graph descriptor for ordered inputs, unique entry/exit
  and cycle validation; use it from new subflow typing and align NNTree
  compilation with the same structural contract.
- Implement `apply` and `iterate` with fresh local scope per application,
  inherited globals, memoized repeated projections and iteration-aware errors.
- Test a normal shape-changing subflow, declarative HorizontalRepeat, a
  shape-changing Repeat, and a Repeat that becomes invalid on the next step.
- Completion: subflow semantics are selected only by expression nodes and
  runtime/type traversal agree on entry, exit and Join order.

#### Phase 5 / T05-T07 - migrate declarations in parallel

- T05 migrates all module/source/loss JSON and fixes only semantics expressible
  by agreed generic primitives. Runtime-interface ambiguities are documented or
  explicitly constrained to the supported subset; no engine workaround is
  allowed.
- T06 migrates Join JSON: Addition and Concat become `2..*`, MatMul and
  attention use two `1..1` groups, and Einsum uses `EinsumShape`.
- T07 migrates Repeat/HorizontalRepeat and introduces the generic subflow
  signature/legacy anonymous-node normalization contract.
- Completion: a repository-wide loader test compiles every bundled JSON as v2
  with no legacy `action`, `infer_then_transform`, `last_dim`, `multiply`,
  `dim_expr`, `einsum_param` or signature `kind` fields.

#### Phase 6 / T08 - atomic production cutover

- Modify `StereotypeCore` to decode unknown JSON into immutable compiled
  signatures and aggregate load failures.
- Replace the body of `typeEngine.ts` with graph orchestration plus calls to the
  generic evaluator/subflow capability; keep the public `TypeEngine.infer()` and
  `TypeResult` contracts stable.
- Update/rewrite current type-engine tests around externally observable
  behavior, removing stale action-specific assumptions.
- Remove `JoinConfig`, `SubflowConfig`, `SubflowTransform` and the old action
  branches in the same change.
- Completion: production diagrams use one evaluator and the complete focused
  frontend suite passes without any compatibility flag.

#### Phase 7 / T09 - editor and serialization arity

- Modify `JoinNode.svelte`, `DiagramCore`, node config and Browser RPC creation
  so defaults and +/- controls follow the compiled groups' total lower/upper
  bounds.
- Preserve saved `inputsCount`; invalid imported counts remain visible but
  receive a type diagnostic rather than being silently rewritten.
- Ensure fixed two-input signatures cannot add a third handle and unbounded
  Addition/Concat can.
- Completion: UI, RPC and imported diagrams expose identical arity behavior.

#### Phase 8 / T10 - cleanup and architectural guards

- Keep `front-end/src/expr/` as the single human-readable parser/compiler/
  evaluator authority. Remove only duplicated legacy numeric evaluation paths
  and temporary bare-parameter compatibility once migrated JSON is canonical.
- Add loader tests that reject invalid expressions at load time.
- Add an architectural test that forbids `StereotypeCore` imports and legacy
  action fields in the generic evaluator, plus a synthetic never-before-seen
  stereotype test proving no engine edit is needed.
- Review source for ordinary stereotype name literals; allow `einsum` only as a
  `ShapeDefinition` discriminant/evaluator.
- Completion: deleting/changing a stereotype JSON cannot require a generic
  engine branch, and forbidden dependencies fail CI.

#### Phase 9 / T11 - documentation and final proof

- Update `docs/knowledge/contracts/tensor-types.md`,
  `docs2/source/type_system.rst`, repository/package `AGENTS.md` guidance and
  any report text that still calls action dispatch data-driven.
- Run focused tests, frontend check/full suite and relevant smoke/convert/forward
  integration tiers.
- In the live editor verify a normal layer, three-input Addition and Concat,
  MatMul input ordering, normal subflow, HorizontalRepeat, shape-changing Repeat,
  failing Repeat iteration and Einsum.
- Completion: public behavior, docs and architecture checks all agree.

### E.3 Compatibility policy

- Saved diagrams store stereotype names/parameters, not the type signatures, so
  v2 migration does not require rewriting normal diagram JSON.
- Keep current dimension leaf discriminants where possible and accept `$`/`#`
  prefixes in pattern declarations only in a temporary migration decoder/test;
  canonical v2 patterns use explicit scope. Expression source keeps readable
  `$H` symbol references, resolved against those explicit declarations.
- Do not ship a permanent adapter for legacy action values. Such an adapter
  would preserve the same semantic hardcoding outside `TypeEngine` and make the
  architecture claim false.
- If third-party stereotype files become a supported runtime feature, provide
  an offline v1-to-v2 migration command and a versioned error. The current Vite
  glob bundles repository-owned files, so a permanent compatibility evaluator
  is not justified now.

## F. Stato finale desiderato

`TypeEngine` should be a small graph orchestrator. For each node it collects
ordered predecessor types, obtains an already compiled signature, supplies
parameters and optional subflow capability, and records the generic evaluator's
annotation/diagnostics. The generic subsystem knows only:

- input-group allocation;
- pattern matching/unification and scope;
- parameter and spread resolution;
- typed expression evaluation;
- `ShapeDefinition` dispatch;
- constraint and dtype validation;
- `EinsumShape` equation evaluation;
- generic `apply`/`iterate` callbacks.

It must contain no semantic knowledge of Addition, Concat, HorizontalRepeat or
Repeat. Einsum is special only because `output.kind === "einsum"`; renaming the
stereotype or creating a second stereotype with `EinsumShape` changes nothing.

The final dependency boundary is:

```text
Stereotype JSON --decode/compile--> CompiledTypeSignature
                                      |
ordered graph inputs + params --------+
                                      v
                          generic signature evaluator
                           | pattern / computed / einsum
                           | constraints / dtype
                           | apply / iterate capability
                                      v
                              TensorType + diagnostics
```

This reaches the architectural principle: adding a new ordinary stereotype is
a data/test change whenever its typing is expressible with existing primitives.
Changing the engine is reserved for a new general language primitive.

## G. Rischi e questioni aperte

### G.1 Decisions required before promotion to `ready`

1. **Constraint severity extension:** approve `severity/category` on
   `TypeConstraint`, or accept loss of current non-fatal advisories. Recommended:
   extend the metamodel.
2. **Unset `ParameterSpreadDimension`:** approve named deferred sequence/binding
   semantics and invalid-as-error. Recommended: do so; the current single fake
   output dimension is unsound.
3. **Anonymous subflow:** approve a generic Subflow stereotype plus import
   normalization. Recommended: do so; a hidden engine signature would recreate
   procedural semantics.
4. **Runtime-incomplete stereotypes:** decide whether this initiative fixes
   Flatten/Unflatten/Pool/Upsample/SequencePool signatures to their runtime or
   preserves and documents a supported subset. Recommended: fix the pure shape
   cases now; handle MultiheadAttention/Transformer/Decoder runtime adapters in
   a separate initiative rather than lying in the type signature.

### G.2 Technical risks

- Extending the readable DSL with restricted lambdas and static result types is
  more parser work than exposing an AST-shaped JSON schema. It is nevertheless
  the correct authoring boundary: control the risk with one closed grammar,
  reuse the current parser, compile at load time and never execute host code.
- Higher-order `map/all/iterate` nodes need strict recursion and iteration limits
  to avoid pathological stereotype declarations.
- Deferred symbolic arithmetic must preserve expression identity; treating all
  unresolved computed dimensions as equal repeats the current soundness bug.
- A graph-wide global scope can couple disconnected branches by design. Tests
  must state that `GLOBAL` means one root inference session, not one path.
- Repeated subflow evaluation reuses visual node IDs. Diagnostics need an
  iteration trace while the UI still exposes one annotation per visual node.
- Output wildcard capture from the first input is a generic but restrictive
  convention. Use `ComputedShape` for other sources; do not add hidden per-Join
  selection logic.
- Updating Join arity may expose imported diagrams whose visible handle count
  and connected handle suffixes disagree. Diagnose; do not reorder or mutate
  persisted edges silently.
- Aligning type and NNTree subflow topology can reject previously ambiguous
  multi-exit subflows. This is correct while `TypeSignature` has exactly one
  output, but it is a compatibility change that needs a clear error.

### G.3 Metamodel limits intentionally retained

- One tensor output per signature and one structural exit per subflow.
- At most one wildcard per `ShapePattern` until matching policy for multiple
  rest segments is specified.
- No permanent legacy action schema.
- No generic PyTorch runtime adapter generation from type expressions.

## Integration and review gates

- Generic evaluator files do not import `StereotypeCore`, `DiagramCore`, Svelte
  nodes or stereotype JSON.
- No production schema contains `action`, `infer_then_transform`,
  `last_dim`, `multiply`, `dim_expr` or `einsum_param`.
- A three-input Addition and Concat use the same group binder as a synthetic
  variadic stereotype.
- A renamed stereotype carrying `EinsumShape` still uses Einsum inference; a
  stereotype named `Einsum` with a normal pattern does not.
- Repeat applies a shape-changing internal transform N times and reports the
  exact incompatible iteration.
- Invalid expressions fail stereotype loading, not later console logging.
- Type/NNTree Join ordering remains numeric by target handle.
- Legacy saved diagrams load without embedded-signature migration.

## Acceptance criteria

- [ ] All bundled stereotype type signatures compile under the v2 schema.
- [ ] Ordinary layers cover fixed, wildcard, scoped symbolic, parameter,
      parameter-spread and computed dimensions.
- [ ] `InputGroup` covers fixed and variadic arity and is reflected by the UI.
- [ ] Addition, MatMul, Concat, HorizontalRepeat and Repeat have no semantic
      engine branches.
- [ ] `EinsumShape` is the only intentional special shape evaluator.
- [ ] Constraints, dtype expressions and load-time expression errors have
      user-readable diagnostics.
- [ ] Architectural guards and a synthetic new-stereotype test prevent name
      hardcoding from returning unnoticed.
- [ ] Existing graph mutation, diagnostic serialization and NNTree contracts
      remain compatible.

## Final verification

Run from the repository root:

```bash
pnpm --dir front-end test -- src/__tests__/typeSchema.test.ts src/__tests__/typeExpressions.test.ts src/__tests__/signatureEvaluator.test.ts src/__tests__/subflowTypeExpressions.test.ts src/__tests__/typeArchitecture.test.ts
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end test:integration:smoke
pnpm --dir front-end test:integration:convert
pnpm --dir front-end test:integration:forward
pnpm run docs
```

Use the live editor for the cases listed in T11 and verify diagnostics through
the same browser/RPC surface used by users.

## Knowledge and archive impact

- Replace the action-based contract in
  `docs/knowledge/contracts/tensor-types.md` when T08 lands.
- Update public type-system documentation and repository/package agent guidance
  only after the production cutover makes it true.
- Preserve useful final validation evidence under this initiative, then mark it
  `done` and move the directory intact to
  `docs/archive/completed-plans/declarative-type-system/`.
