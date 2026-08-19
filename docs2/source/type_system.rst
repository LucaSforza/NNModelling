Tensor Type System
==================

NNModelling checks tensor shapes and dtypes as you edit a diagram, before
conversion or Python execution. A mismatch is shown on the relevant node and
conversion is blocked by hard type errors.

The system is declarative: stereotype JSON supplies a version-2
``type_signature`` and the editor evaluates it generically. Adding a normal
layer therefore means declaring its contract and testing it, rather than adding
a branch for the layer's name in TypeScript.

Signatures
----------

Each signature has ordered input groups, one output shape definition, an output
dtype expression, and optional input-dtype and constraint expressions:

.. code-block:: json

   {
     "version": 2,
     "inputs": [{
       "lower": 1,
       "upper": 1,
       "pattern": {
         "kind": "pattern",
         "dims": [
           { "kind": "symbolic", "name": "B", "scope": "global" },
           { "kind": "wildcard" },
           { "kind": "param_ref", "name": "in_features" }
         ]
       }
     }],
     "output": {
       "kind": "pattern",
       "dims": [
         { "kind": "symbolic", "name": "B", "scope": "global" },
         { "kind": "wildcard" },
         { "kind": "param_ref", "name": "out_features" }
       ]
     },
     "to_dtype": "dtype(input(0, 0))"
   }

An input group is an ordered partition of incoming tensors. ``lower`` and
``upper`` set its arity; ``null`` for ``upper`` means unbounded. The Join node
uses these bounds for its add/remove controls, so a three-input Add or a
variadic Concat is represented in the signature rather than in editor code.
An optional ``label`` improves diagnostics. The input order is the order of
Join handles (``in-0``, ``in-1``, ...), which matters for non-commutative
operations such as MatMul.

Shapes and symbols
------------------

A pattern contains literal dimensions (``const``), symbolic dimensions,
parameter references (``param_ref``), wildcards, computed dimensions, and
parameter spreads. A wildcard matches zero or more dimensions; when used in an
ordinary output pattern, it replays the capture from the first occurrence of
the first input group.

Symbols declare their scope explicitly. A ``global`` binding propagates through
the graph; a ``local`` binding is only available while evaluating the current
signature. A symbol name cannot use both scopes in one signature. This makes
the shared batch dimension and private intermediate relationships unambiguous.

``param_ref`` reads one declared node parameter. ``param_spread`` normalizes a
list-valued parameter and expands it into several dimensions. Invalid parameter
text is diagnosed; a compatible unresolved value can result in a suggestion.

Output definitions
------------------

``output`` is one of three shape definitions:

* ``pattern`` resolves dimension-by-dimension and is sufficient for most
  layers.
* ``computed_shape`` evaluates a whole-shape expression. It handles generic
  transformations such as replacing an axis, concatenation, or rank changes.
* ``einsum`` is the deliberate special case. It references the parameter that
  contains the Einstein equation; only ``output.kind == "einsum"`` selects the
  equation evaluator. It is not selected by a layer name or legacy action, and
  equations with ellipsis are rejected.

For example, Concat is declared as a variadic group plus generic expressions:

.. code-block:: json

   {
     "inputs": [{ "lower": 2, "upper": null, "label": "input",
       "pattern": { "kind": "pattern", "dims": [{ "kind": "wildcard" }] } }],
     "output": { "kind": "computed_shape",
       "expr": "let first = input(0, 0) in let a = axis(param.dim, rank(first)) in replace(shape(first), a, sum(map(inputs(0), x => dim(x, a))))" },
     "constraints": [{
       "condition": "let first = input(0, 0) in let a = axis(param.dim, rank(first)) in all(inputs(0), x => rank(x) == rank(first) and remove(shape(x), a) == remove(shape(first), a))",
       "message": "Concat inputs must match outside the selected axis"
     }],
     "to_dtype": "dtype(input(0, 0))"
   }

Expression DSL
--------------

Expressions are readable source strings in JSON. During stereotype loading the
schema validates the JSON, checks names and scopes, parses each expression, and
type-checks it for its expected result: dimension, shape, boolean constraint,
or dtype. The resulting AST is internal and is never serialized.

The safe DSL supports ``param.name``, ``$symbol``, ``$*``, arithmetic,
comparisons, lists and shape helpers such as ``shape``, ``rank``, ``dim``,
``replace`` and ``splice``. It also supports ``map``, ``sum``, ``all``,
``apply`` and ``iterate``. There is no JavaScript evaluation, arbitrary host
call, mutation, I/O, or dynamic property traversal.

Subflows use the same primitives. ``apply(tensor)`` evaluates the contained
graph once; ``iterate(count, tensor, step)`` composes a declared transform.
Repeat and HorizontalRepeat are therefore signature expressions, not special
Subflow actions in the engine.

Constraints and dtypes
----------------------

Constraints are reusable boolean expressions. Their severity is ``error`` by
default, or ``warning`` for advisory diagnostics; a category can group warnings
in the editor. ``from_dtype`` expresses an expected input dtype and reports a
warning when it differs. ``to_dtype`` is required and explicitly declares the
output dtype.

Diagnostics and extension
-------------------------

The editor records hard errors, categorized warnings, inferred input/output
annotations, and parameter suggestions. A node affected by an upstream failure
is marked as blocked instead of repeating the same error.

To add a conventional layer, add or update its v2 stereotype signature and its
tests. Engine changes are reserved for genuinely new generic primitives, and
must include schema, expression, and evaluator coverage. Do not introduce
action fields, formula-name switches, category branches, or ordinary
stereotype-name branches. ``EinsumShape`` remains the sole specialized shape
primitive, selected only by its output discriminant.

Further Reading
---------------

* :doc:`stereotypes` — stereotype JSON structure
* ``docs/knowledge/contracts/tensor-types.md`` — current internal contract
* ``front-end/src/type-system/model.ts`` — signature model
* ``front-end/src/type-system/schema.ts`` — load-time validation
* ``front-end/src/type-system/signatureEvaluator.ts`` — generic evaluation
