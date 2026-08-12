Tensor Type System
==================

A fundamental challenge in visual DSLs for neural network design is the lack
of compile-time feedback about tensor shape compatibility. In NNModelling, a
user may connect a ``Linear`` layer expecting 784 input features to a
``Conv2d`` layer producing a 3D tensor without any editor-level warning. The
shape mismatch is only discovered at runtime when PyTorch raises a dimension
error during training.

To address this, NNModelling includes a **static tensor type system** that
verifies tensor shapes and dtypes during visual editing and front-end
compilation. The type system is integrated into the DSL as a separate
verification pass, preserving the existing architecture while extending the
language with compile-time safety guarantees. It is **data-driven**: all
module-specific logic is declared in ``type_signature`` fields inside
stereotype JSON files, so adding a new module requires only a JSON change —
never a TypeScript modification.

How the Type System Helps
-------------------------

Consider this diagram:

.. code-block:: text

   Input ── Linear(784 → 256) ── ReLU ── Linear(300 → 10) ── CrossEntropyLoss

The second Linear expects 300 input features, but the ReLU outputs 256. This
is a shape mismatch that would cause a runtime crash. Without a type system,
you would only discover this after clicking Convert, training, and reading a
PyTorch error trace.

With the type system, the error appears the moment you connect the second
Linear:

.. code-block:: text

   ✗ Linear_2: dimension mismatch: param in_features=300, got 256

The node turns red. You fix the parameter immediately and move on.

Following a Tensor Through the Graph
-------------------------------------

Let us walk through a well-typed diagram to see how the engine processes
shapes:

.. code-block:: text

   Input(out_features=784) ── Linear(784→256) ── ReLU ── Linear(256→10) ── Loss

**Step 1 — Input**. The Input node is a source: it has no predecessor. Its
type signature declares an output shape :math:`[B, \text{out\_features}]`
where :math:`B` is a fresh symbolic variable representing the batch dimension
and ``out_features`` is read from the node's parameter. With
``out_features=784``, the output type is:

.. code-block:: text

   Tensor([B, 784], float32)

**Step 2 — Linear(784→256)**. The Linear node declares its contract as
:math:`[B, *, \text{in\_features}] \rightarrow [B, *, \text{out\_features}]`.
The wildcard :math:`*` matches zero or more intermediate dimensions. The
engine checks that the incoming last dimension equals the node's
``in_features`` parameter (784 = 784), then produces:

.. code-block:: text

   Tensor([B, 256], float32)

**Step 3 — ReLU**. ReLU is shape-preserving: its signature is
:math:`[*] \rightarrow [*]`. The wildcard captures the entire input shape
:math:`[B, 256]` and reproduces it unchanged in the output.

**Step 4 — Linear(256→10)**. The engine checks that :math:`256 = 256`
(``in_features`` matches), producing:

.. code-block:: text

   Tensor([B, 10], float32)

The entire graph is well-typed: no errors.

Now change the first Linear's ``in_features`` to 512:

.. code-block:: text

   Input ── Linear(512→256) ── ReLU ── Linear(256→10) ── Loss

The Input still produces :math:`[B, 784]`. The first Linear expects its last
dimension to be 512, but the incoming shape is :math:`[B, 784]`. The engine
reports a type error at the Linear node:

.. code-block:: text

   ✗ dimension mismatch: param in_features=512, got 784

The error surfaces immediately in the editor's error panel, and the node
acquires a red border.

Formal Definition
-----------------

We now define the type system formally. The mathematical presentation
follows the standard notation of type theory and is drawn from the project's
academic report.

Tensor Types
~~~~~~~~~~~~

A tensor type :math:`\tau` is a pair consisting of a shape and a data type:

.. math::

   \tau ::= \text{Tensor}(\sigma, \delta)

where :math:`\sigma` is a tensor shape and :math:`\delta` is a tensor data
type (e.g. ``float32``, ``float64``, ``int64``).

Shape Dimensions
~~~~~~~~~~~~~~~~

A shape :math:`\sigma` is a finite sequence of dimensions
:math:`d_1, d_2, \ldots, d_n`. Each dimension :math:`d` belongs to one of
the following categories:

.. math::

   d ::= c \mid x \mid p \mid * \mid e \mid p^*

where:

* :math:`c \in \mathbb{N}` is a **constant** dimension (e.g. 3, 784, 1)
* :math:`x \in \mathcal{X}` is a **symbolic** dimension variable (e.g.
  :math:`B` for batch size, :math:`H` for height, :math:`W` for width) —
  these represent unknown dimensions whose values are determined during
  type inference but remain symbolic in the type representation
* :math:`p \in \mathcal{P}` is a **parameter reference** (e.g.
  ``in_features``, ``out_channels``) — these refer to node parameter values
  that are resolved at inference time
* :math:`*` is the **wildcard** dimension, matching zero or more arbitrary
  dimensions. A wildcard in an input pattern consumes matching dimensions
  from the actual tensor; in an output pattern, it reproduces the dimensions
  consumed during input matching
* :math:`e` is a **computed dimension**, evaluated by the expression language
  from symbolic bindings and node parameters
* :math:`p^*` is a **parameter spread**, expanding a tuple-valued parameter
  into multiple output dimensions

This representation allows the type system to express partially known shapes
— containing symbolic variables and wildcards — rather than requiring every
dimension to be a concrete integer. This is essential for modelling neural
network architectures, where the batch size is unknown at definition time
and intermediate feature dimensions depend on upstream layers.

Typing Context
~~~~~~~~~~~~~~

The typing context :math:`\Gamma` is a partial mapping from symbolic
dimension names to their resolved values:

.. math::

   \Gamma ::= \{ x_1 \mapsto d_1,\; x_2 \mapsto d_2,\; \ldots \}

The context is populated incrementally during type inference as symbolic
dimensions are bound to concrete values. In addition, :math:`\Gamma` carries
dtype information and maintains a mapping from node identifiers to their
inferred tensor types.

Typing Judgments
~~~~~~~~~~~~~~~~

The central judgment form for node-level type inference is:

.. math::

   \Gamma, P \vdash M : (\tau_{\text{in}} \rightarrow \tau_{\text{out}})

meaning: "in context :math:`\Gamma` with parameter values :math:`P`,
module :math:`M` maps input type :math:`\tau_{\text{in}}` to output type
:math:`\tau_{\text{out}}`."

For graph-level inference, the judgment extends to:

.. math::

   \Gamma \vdash G : \Gamma'

meaning: "graph :math:`G` is well-typed, producing the extended environment
:math:`\Gamma'` containing type annotations for every node."

Inference Rules
~~~~~~~~~~~~~~~

The typing rules are defined per module type. Each rule is derived
declaratively from the ``type_signature`` field in the module's stereotype
JSON, rather than being hardcoded in the inference engine. This data-driven
approach ensures that adding a new module requires only extending its
stereotype definition, with no changes to the TypeScript implementation.

**Input Node.** The Input node is a source in the computation graph. It
produces a tensor whose last dimension is determined by its
``out_features`` parameter and whose batch dimension is a fresh symbolic
variable:

.. math::

   \frac{
     \text{stereotype}(v) = \text{Input}
     \qquad
     P = \text{params}(v)
   }{
     \Gamma \vdash v :
     \text{Tensor}((B,\, P.\text{out\_features}),\, \text{float32})
   }

where :math:`B` is a fresh symbolic dimension variable introduced into
:math:`\Gamma`.

**Linear Layer.** A Linear layer applies an affine transformation to the
last dimension of its input:

.. math::

   \frac{
     \Gamma \vdash x :
     \text{Tensor}((B, \alpha_1, \ldots, \alpha_k, F), \delta)
     \qquad
     F = P.\text{in\_features}
   }{
     \Gamma \vdash \text{Linear}(P)(x) :
     \text{Tensor}((B, \alpha_1, \ldots, \alpha_k, P.\text{out\_features}), \delta)
   }

where :math:`\alpha_1, \ldots, \alpha_k` are intermediate dimensions matched
by a wildcard pattern and carried forward unchanged. The last dimension
:math:`F` must equal the declared ``in_features`` parameter; if this
constraint is violated, a type error is emitted.

**ReLU Activation (Shape-Preserving).** Activation functions are
shape-preserving and dtype-preserving:

.. math::

   \frac{
     \Gamma \vdash x : \text{Tensor}(\sigma, \delta)
   }{
     \Gamma \vdash \text{ReLU}(x) : \text{Tensor}(\sigma, \delta)
   }

The same rule applies to all shape-preserving modules: Tanh, Sigmoid,
Softmax, Dropout, BatchNorm1d, BatchNorm2d, LayerNorm.

How Modules Declare Their Contracts
------------------------------------

Every stereotype JSON can include a ``type_signature`` field that declares
the module's shape contract. This is the bridge between the formal type
system above and the concrete implementation.

Input
~~~~~

.. code-block:: json

   "type_signature": {
     "kind": "module",
     "input": [],
     "output": [
       { "kind": "symbolic", "name": "$B" },
       { "kind": "param_ref", "name": "out_features" }
     ],
     "dtype": { "output": "float32" }
   }

The empty ``input`` array means "I have no input — I am a source." The
``output`` says "I produce :math:`[B, \text{out\_features}]` with dtype
``float32``."

Linear
~~~~~~

.. code-block:: json

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

The pattern :math:`[B, *, \text{in\_features}]` means: match a batch
dimension, then zero or more intermediate dimensions captured by the
wildcard, then require the last dimension to equal the ``in_features``
parameter. The output preserves the batch and intermediate dimensions while
replacing the last dimension with ``out_features``.

A naming convention applies to all JSON type signatures: symbolic names
start with ``$`` (``"$B"``, ``"$H"``, ``"$W"``) to distinguish them from
parameter references, which never have the prefix. The ``$`` is stripped
when the JSON is loaded into the engine.

ReLU and Shape-Preserving Modules
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. code-block:: json

   "type_signature": {
     "kind": "module",
     "input": [{ "kind": "wildcard" }],
     "output": [{ "kind": "wildcard" }]
   }

The wildcard on both input and output means "I accept any shape, and the
output shape equals the input shape." This single pattern covers ReLU, Tanh,
Sigmoid, Softmax, Dropout, BatchNorm1d, BatchNorm2d, and LayerNorm.

Loss as a Conceptual Layer
~~~~~~~~~~~~~~~~~~~~~~~~~~

Loss stereotypes are layers in the DSL type model. They accept the prediction
tensor and expose a conceptual rank-1 result ``[B]``, where ``B`` is the batch
dimension. The output handle is intentionally visible, so both a user and an
MCP client can inspect this inferred type.

The Python backend does not yet implement the same data-flow semantics: during
conversion, a Loss is extracted as a terminal training objective. Propagating
its rank-1 result through ``converted/`` is planned future work and must not be
assumed by generated models today.

The Notation Rule for ``$``
~~~~~~~~~~~~~~~~~~~~~~~~~~~

In JSON, symbolic dimension names start with ``$`` (``"$B"``, ``"$H"``,
``"$W"``). Parameter references never have ``$`` (``"in_features"``,
``"out_channels"``). When loaded, ``"$B"`` becomes ``{ kind: 'symbolic',
name: 'B' }`` — the ``$`` is stripped, leaving only the canonical name.

The Inference Engine
--------------------

The type engine (``TypeEngine`` in ``typeEngine.ts``) implements the formal
rules above as a constraint-based algorithm operating in two phases:

**1. Constraint Generation.** For each node visited in topological order,
the engine reads the node's ``type_signature`` and generates constraints by
pattern-matching the actual input shape against the declared input pattern.
This produces:

* **Bindings**: symbolic dimensions in the pattern are bound to their
  matched concrete values
* **Substitutions**: wildcard dimensions capture a suffix of the actual
  shape for reuse in the output pattern
* **Resolutions**: parameter references are resolved to the node's current
  parameter values

**2. Constraint Solving.** The engine substitutes bound variables and
captured wildcards into the output pattern, producing the output tensor
type. If any constraint is violated (a constant dimension does not match,
a dtype constraint fails, a parameter reference cannot be resolved), a
``TypeError`` is recorded on the offending node. Diagnostics are
deduplicated: one underlying mismatch should produce one primary error.

The algorithm in pseudocode:

.. code-block:: text

   TypeEngine.infer(diagram):
     1. Build topological order (Kahn's algorithm on top-level nodes)
     2. For each node in order:
        a. Read stereotype and typeSignature
        b. If no typeSignature → warning, treat output as "unknown"
        c. Determine input type(s) from predecessor annotations
        d. If an input is blocked by an upstream TypeError:
             store annotation with blockedBy = [upstream node IDs]
             skip constraint checking for this node
        e. Otherwise call patternMatch(inputShape, inputPattern, params, env)
        f. If match fails → record one primary TypeError
        g. Resolve output: substitute bindings + captured wildcards
        h. Store annotation, update environment
     3. Return { ok, annotations, errors }

Nodes marked with ``blockedBy`` are not independent type errors. Their
diagnostics are suppressed because their input type is already unreliable;
the annotation preserves the upstream node IDs so callers can explain the
dependency. This prevents a single shape mismatch from producing a long,
misleading cascade of downstream errors.

Pattern Matching
~~~~~~~~~~~~~~~~

The core pattern matching algorithm walks input dimensions and pattern
elements with a two-pointer approach:

.. list-table:: Pattern matching behaviour
   :header-rows: 1
   :widths: 20 80

   * - Kind
     - Behaviour
   * - ``const``
     - The input dimension must equal the constant value.
   * - ``symbolic``
     - An existing :math:`\Gamma` binding is unified with the input;
       otherwise a new binding is added.
   * - ``param_ref``
     - The node parameter is resolved and compared with the input dimension.
       A non-numeric value is a type error, not an unset value.
   * - ``wildcard``
     - Consumes zero or more dimensions with lookahead and captures them for
       substitution into the output.
   * - ``computed``
     - Passes through on input; its expression is resolved on output.
   * - ``param_spread``
     - Reads a tuple parameter, consumes or produces the corresponding number
       of dimensions, and materializes its entries as constants.

**Wildcard lookahead.** The wildcard does not blindly consume all remaining
dimensions. It computes how many are needed for subsequent non-wildcard
pattern elements and reserves them. For the pattern :math:`[B, *,
\text{in\_features}]` on input :math:`[B, 128, 784]`: the wildcard consumes
one dimension (128), leaving the last for ``in_features``. On input
:math:`[B, 784]` it consumes zero dimensions.

**Symbolic unification.** When a symbolic name appears in multiple positions
(e.g. :math:`\$K` in both MatMul input patterns), the engine verifies that
all occurrences bind to the same concrete value. If they conflict, a
unification error is reported.

Computed Dimensions
-------------------

Some modules produce output dimensions that depend on their parameters in
non-trivial ways. These are expressed through the ``computed`` dimension
kind using a **mini expression language**. Instead of hardcoded formula
names (``conv2d_hw``, ``pool2d_hw``), each stereotype now declares its
computation as an inline arithmetic expression — eliminating all
module-specific logic from the TypeScript engine.

Conv2d
~~~~~~

The output height and width of a convolution are computed from the input
size, kernel size, stride, padding, and dilation:

.. math::

   H_{\text{out}} = \left\lfloor \frac{H + 2p - d(k - 1) - 1}{s} + 1 \right\rfloor

The type signature declares this directly:

.. code-block:: json

   "output": [
     { "kind": "symbolic", "name": "$B" },
     { "kind": "param_ref", "name": "out_channels" },
     { "kind": "computed",
       "expr": "floor(($H + 2*padding - dilation*(kernel_size - 1) - 1)/stride + 1)" },
     { "kind": "computed",
       "expr": "floor(($W + 2*padding - dilation*(kernel_size - 1) - 1)/stride + 1)" }
   ]

For a 3×3 convolution with stride 1 and padding 1 on a 32×32 input:
:math:`(32 + 2(1) - 1(3-1) - 1) / 1 + 1 = 32` (the output is the same size).

MaxPool2d and AvgPool2d
~~~~~~~~~~~~~~~~~~~~~~~

.. math::

   H_{\text{out}} = \left\lfloor \frac{H + 2p - k}{s} + 1 \right\rfloor

For 2×2 pooling with stride 2 on a 32×32 input:
:math:`(32 + 0 - 2) / 2 + 1 = 16` (halves the spatial dimensions).

Flatten
~~~~~~~

The flattened dimension is the product of all wildcard-captured dimensions
(referenced as ``$*`` in the formula arguments):

.. math::

   d_{\text{flat}} = \prod_i d_i

For :math:`[B, 128, 7, 7]`: :math:`128 \times 7 \times 7 = 6272` →
:math:`[B, 6272]`.

Expression Language
~~~~~~~~~~~~~~~~~~~

The expression language used in ``computed`` ``expr`` fields is a small,
safe arithmetic language that replaces all previously hardcoded formula
bodies (``resolveFormula``, ``resolveComputedArg``). Every computed
dimension in the codebase now uses it.

**Grammar.** The language supports the standard arithmetic operators with
correct precedence:

.. code-block:: text

   expr        := additive
   additive    := multiplicative (("+" | "-") multiplicative)*
   multiplicative := unary (("*" | "/" | "//" | "%") unary)*
   unary       := "-" unary | primary
   primary     := NUMBER | VARIABLE | FUNC_CALL | "(" expr ")"

**Operators** (precedence from lowest to highest):

+-------------+------------------------------------------------------------+
| Category    | Operators                                                  |
+=============+============================================================+
| Additive    | ``+``, ``-``                                               |
+-------------+------------------------------------------------------------+
| Multiplicative | ``*``, ``/``, ``//`` (floor div), ``%`` (modulo)        |
+-------------+------------------------------------------------------------+
| Unary       | ``-`` (negate)                                             |
+-------------+------------------------------------------------------------+

**Built-in functions:**

+-------------+----------------------------+-------------------------------+
| Function    | Signature                  | Description                   |
+=============+============================+===============================+
| ``floor(x)``| ``number → number``        | Round down (integer)          |
+-------------+----------------------------+-------------------------------+
| ``ceil(x)`` | ``number → number``        | Round up (integer)            |
+-------------+----------------------------+-------------------------------+
| ``abs(x)``  | ``number → number``        | Absolute value                |
+-------------+----------------------------+-------------------------------+
| ``max(a,b)``| ``number, number → number``| Maximum of two values         |
+-------------+----------------------------+-------------------------------+
| ``min(a,b)``| ``number, number → number``| Minimum of two values         |
+-------------+----------------------------+-------------------------------+

**Variable resolution.** Three kinds of variable are recognised:

+-------------+---------------+----------------------------------------------+
| Syntax      | Resolves From | Example                                      |
+=============+===============+==============================================+
| ``$NAME``   | Symbolic env  | ``$H`` → height dim bound in pattern match   |
+-------------+---------------+----------------------------------------------+
| ``$*``      | Captured dims | ``$*`` → product of wildcard dims (Flatten)  |
+-------------+---------------+----------------------------------------------+
| ``name``    | Node params   | ``kernel_size``, ``padding``, ``stride``     |
+-------------+---------------+----------------------------------------------+

**Conv2d example — how variables resolve.** For a layer with
``kernel_size=3``, ``stride=1``, ``padding=1``, ``dilation=1`` on a
:math:`32 \times 32` input:

.. code-block:: text

   expr: floor(($H + 2*padding - dilation*(kernel_size - 1) - 1)/stride + 1)

      $H        → env["H"]        = 32    (symbolic, bound during matching)
      padding   → params.padding  = 1
      dilation  → params.dilation = 1
      kernel_size → params.kernel_size = 3
      stride    → params.stride   = 1

      floor((32 + 2*1 - 1*(3 - 1) - 1) / 1 + 1) = floor(32) = 32

If any variable cannot be resolved (e.g. a parameter is unset or a symbolic
dimension has not been bound), the computed dimension is deferred — the
engine keeps it as a symbolic ``computed`` node rather than erroring. This
graceful degradation allows partial typing to work during editing.

**All stereotype logic is now fully declarative.** Every module-specific
shape computation lives in the stereotype JSON — no TypeScript changes are
needed to add or modify a module's type signature. This includes computed
dimensions (5 stereotypes), subflow transforms (Repeat, HorizontalRepeat),
and join configuration (Concat dim resolution).

Param Spread — Tuple Expansion
------------------------------

Some modules produce output tensors with *more dimensions* than their input.
For example, ``nn.Unflatten`` takes a flattened 2D tensor ``[B, N]`` and
produces a 3D tensor ``[B, d1, d2]`` where ``d1 × d2 = N``. The output
shape is determined by a **tuple parameter** (e.g. ``unflattened_size =
(1, 100)``).

The ``param_spread`` pattern kind handles this: it reads a tuple parameter
and expands it into multiple output dimensions.

Unflatten
~~~~~~~~~

The ``Unflatten`` module uses ``param_spread`` in its output pattern:

.. code-block:: json

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

When ``unflattened_size = (1, 100)``:

- **Input pattern**: ``$B`` binds the batch dimension; ``wildcard`` captures
  the remaining dimension(s).
- **Output pattern**: ``$B`` propagates the batch; ``param_spread`` reads
  the tuple ``(1, 100)`` and produces two const dimensions →
  ``[B, 1, 100]``.

This is the only way to model rank-changing operations in the type system.
The ``computed`` pattern kind can compute *values* for existing dimensions,
but cannot add new dimensions. ``param_spread`` fills this gap for any
module whose output shape is parameterized by a tuple.

**Tuple parsing.** The parameter value is parsed as a comma-separated list
of integers, with optional parentheses:

+---------------------+-------------------+
| Parameter value     | Parsed as         |
+=====================+===================+
| ``(1, 100)``        | ``[1, 100]``      |
+---------------------+-------------------+
| ``1, 100``          | ``[1, 100]``      |
+---------------------+-------------------+
| ``100``             | ``[100]``         |
+---------------------+-------------------+
| ``(4, 32)``         | ``[4, 32]``       |
+---------------------+-------------------+

**Input behavior.** When ``param_spread`` appears in an input pattern, it
consumes exactly N dimensions (where N is the tuple length). If the tuple
parameter is unset, it behaves like a wildcard (consuming remaining dims).

**Gradual typing.** If the tuple parameter is unset or invalid, the output
type becomes symbolic (unknown shape). No error is reported — the type
propagates as unknown, and errors surface only when a downstream module
expects a specific shape. This is distinct from an unknown type caused by a
known upstream ``TypeError``: in that case downstream nodes are marked with
``blockedBy`` and their duplicate diagnostics are suppressed.

Join Type Checking
------------------

Join nodes accept multiple inputs and merge them into one. The type engine
validates multi-input shape compatibility through pattern matching and
symbolic unification.

**Addition** requires all inputs to have identical shapes. The engine
captures dimensions from the first input's wildcard and verifies that
subsequent inputs produce identical captured dimensions. If one branch
produces :math:`[B, 256]` and another produces :math:`[B, 128]`:

.. code-block:: text

   ✗ Addition: Input 1 dimension 1 mismatch: 256 vs 128

**Concat** concatenates along a specified dimension (:math:`d`). All other
dimensions must match. The output on dimension :math:`d` is the sum of the
input dimensions:

.. math::

   \text{Concat}(\text{dim}=d)(x_1, \ldots, x_n)[d] = \sum_{i=1}^n x_i[d]

For :math:`[B, 128]` and :math:`[B, 64]` with ``dim=-1``, the output is
:math:`[B, 192]`.

**MatMul** constrains the inner dimensions to match through symbolic
unification:

.. math::

   (M, K) \times (K, N) \rightarrow (M, N)

If the first input is :math:`(32, 64)` and the second is
:math:`(128, 64)`, the engine binds :math:`K = 64` from the first and
cannot unify with 128 from the second.

**ScaledDotProduct** validates the full attention shape pattern:

.. math::

   Q(B, H, L, D) \times K(B, H, S, D) \times V(B, H, S, D_{\text{out}}) \rightarrow (B, H, L, D_{\text{out}})

Symbolic unification ensures that :math:`B`, :math:`H`, and :math:`D` are
consistent across Q, K, and V. The output preserves the query length
:math:`L` and value depth :math:`D_{\text{out}}` from V.

***Note.** Einsum uses a declarative ``join.action: "einsum"`` type signature
that delegates output shape computation to a 5-step label-mapping algorithm
(``inferEinsumShape``). The engine parses the Einstein notation equation from
the node's ``expr`` parameter, validates arity and rank compatibility, and
computes the output shape dimension-by-dimension. Ellipsis ``...`` is
explicitly unsupported — the engine emits an error instead.*

Real-Time Feedback in the Editor
---------------------------------

The type engine is wired into the visual editor so that errors surface
immediately as the user edits.

**Trigger events.** ``TypeEngine.infer(diagram)`` is called every time an
edge is added or removed, a parameter changes (debounced 300ms), or a
diagram is loaded.

**Error panel.** The type-check section is part of the vertically scrollable
Sidebar form, so all diagnostics remain reachable even when a node has many
parameters or the graph produces many messages. Errors (red) indicate
primary shape mismatches that would cause runtime crashes. Warnings (amber)
indicate missing type signatures or unresolved parameters. Downstream nodes
blocked by an upstream error are not shown as additional errors; their
``blockedBy`` provenance is retained in the type annotations. Clicking an
error selects the offending node.

**Node indicators.** Nodes with errors display a red border (2px) with an
✗ indicator in the top-right corner. Nodes with warnings display an amber
border with a ⚠ indicator. Indicators disappear when the error is resolved.

**Shape tooltips.** Hovering over a node's output handle shows a tooltip
with the inferred output shape:

.. code-block:: text

   [B, 256]

Implementation Phases
---------------------

The type system was implemented incrementally over six phases:

.. list-table:: Implementation phases
   :header-rows: 1
   :widths: 15 85

   * - Phase
     - What was added
   * - Phase 1
     - Core type model, pattern matching, and Input/Linear/ReLU signatures.
   * - Phase 2
     - Computed dimensions, expression language, shape-preserving modules,
       Embedding, and inline ``expr`` formulas.
   * - Phase 3
     - Multi-input join checking, symbolic unification, and declarative Concat
       dimension resolution.
   * - Phase 4
     - Recursive subflow inference, ``repeat`` composition,
       ``infer_then_transform``, complex module signatures, Loss signatures,
       and Fork.
   * - Phase 5
     - Reactive editor integration, diagnostics panel, node indicators, and
       shape tooltips.
   * - Phase 6
     - Dtype warnings, advisory diagnostics, shape suggestions, join input
       labels, and complete Einsum label-mapping inference.

Further Reading
---------------

* :doc:`stereotypes` — how modules declare their JSON type signatures
* Source: ``front-end/src/conversion/tensortypes.ts`` — type model interfaces
* Source: ``front-end/src/conversion/typeEngine.ts`` — inference engine
  implementation
* Source: ``front-end/src/expr/`` — expression language tokenizer, parser,
  evaluator, and public API
* Tests: ``front-end/src/__tests__/typeEngine.test.ts`` — 269 tests
  (269 passing, 5 skipped) covering all phases
* Tests: ``front-end/src/__tests__/expr.test.ts`` — 54 unit tests for
  expression parsing and evaluation
* Historical design docs:
  ``docs/archive/completed-plans/tensor-type-system/`` — archived
  implementation designs; current contracts live under ``docs/knowledge/``
