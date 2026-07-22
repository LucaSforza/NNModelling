Stereotypes Reference
=====================

Stereotypes define the behavior, appearance, and configurable parameters of
every node in the visual editor. They are stored as JSON files in
``Stereotypes/`` and loaded by ``StereotypeCore`` at runtime.

Each stereotype is a plain JSON file that maps a visual node to a Python class,
defines its input/output behavior, and declares its configurable parameters.

Categories
----------

The ``category`` field determines the node's role in the graph and its handle
configuration:

.. list-table::
   :header-rows: 1
   :widths: 20 40 40

   * - Category
     - Role
     - Handles
   * - ``Input``
     - Network entry point
     - 0 input, 1 output
   * - ``Fork``
     - Passthrough for explicit branching inside subflows
     - 1 input, 1 output
   * - ``Layer``
     - Standard module (Linear, Conv2d, ReLU, Dropout, ...)
     - 1 input, 1 output
   * - ``Loss``
     - Conceptual loss layer / output node (BCELoss, CrossEntropyLoss, ...)
     - 1 input, 1 conceptual output
   * - ``Join``
     - Multi-input merge node (Addition, Concat, MatMul, ...)
     - N inputs, 1 output
   * - ``Subflow``
     - Container holding a sub-graph with structural transformation
     - 1 input, 1 output
   * - ``Observable``
     - Passive interpretability or monitoring analysis
     - Fixed target inputs, no source/output handle
   * - ``Module``
     - Generic; reserved for future use, currently unused
     - Depends on implementation

JSON Field Reference
--------------------

Every stereotype JSON can use these fields:

.. list-table::
   :header-rows: 1
   :widths: 15 10 10 10 55

   * - Field
     - Type
     - Required
     - Default
     - Description
   * - ``category``
     - string
     - yes
     -
     - One of: ``Input``, ``Fork``, ``Layer``, ``Loss``, ``Join``, ``Subflow``, ``Observable``, ``Module``
   * - ``pythonClassName``
     - string
     - yes
     -
     - Fully qualified Python class path, e.g. ``nn.Linear``, ``ops.Addition``, ``ops.Repeat``. Set to ``""`` or ``"None"`` for nodes with no Python counterpart (Input, Fork).
   * - ``taskType``
     - string
     - no
     -
     - Forces a task type (``classification``, ``regression``). Only meaningful on ``Loss`` nodes — overrides automatic detection.
   * - ``view.color``
     - string
     - no
     - ``#cccccc``
     - Default hex color for the node in the editor.
   * - ``view.width``
     - number
     - no
     - ``140``
     - Default node width in pixels.
   * - ``view.height``
     - number
     - no
     - ``60``
     - Default node height in pixels.
   * - ``params``
     - object
     - no
     - ``{}``
     - Map of parameter names to their definitions. Each key is the parameter name.
   * - ``params.<name>.type``
     - string
     - yes
     -
     - Type of the parameter: ``int``, ``float``, ``bool``, ``str``, ``Tensor``.
   * - ``params.<name>.default``
     - string
     - no
     - ``"Undefined"``
     - Default value as a string (parsed by ``ast.literal_eval`` on the Python side).
   * - ``params.<name>.position``
     - string
     - no
     -
     - Display position on the node: ``"top"``, ``"bottom"``, or omit for sidebar-only.
   * - ``observable``
     - object
     - required for ``Observable``
     -
     - Fixed analysis contract: capture kind, supported modes, finalization,
       retention/storage options, ordered input handles, and result schema.
       These semantics are not freely editable instance parameters.
   * - ``type_signature``
     - object
     - no
     -
     - Tensor contract. An Observable uses ``{"kind": "observable", "input": [...]}``
       to validate incoming signals; it has no output type and never propagates
       a type into the computational graph.

Examples
--------

Three representative stereotypes showing the full range of features:

Layer: Linear
~~~~~~~~~~~~~

.. code-block:: json

   {
     "category": "Layer",
     "pythonClassName": "nn.Linear",
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
       }
     }
   }

The most common stereotype pattern: ``category: "Layer"`` maps a visual node to
a ``nn.Module`` subclass. Parameters with ``position: "top"`` are displayed on
the node's upper half, ``position: "bottom"`` on the lower half. Parameters
without a position appear in the sidebar only.

Join: Concat
~~~~~~~~~~~~

.. code-block:: json

   {
     "category": "Join",
     "pythonClassName": "ops.Concat",
     "view": {
       "color": "#2ecc71",
       "width": 80,
       "height": 60
     },
     "params": {
       "dim": {
         "type": "int",
         "default": "-1",
         "position": "top"
       }
     }
   }

Join nodes accept multiple incoming connections (their ``inputsCount`` defaults
to 2 and can be incremented in the UI). The ``pythonClassName`` points to an
``ops.*`` module that implements the merge logic. Input order is preserved from
edge ``targetHandle`` labels (``"in-0"``, ``"in-1"``, ...).

Subflow: Repeat
~~~~~~~~~~~~~~~

.. code-block:: json

   {
     "category": "Subflow",
     "pythonClassName": "ops.Repeat",
     "view": {
       "color": "#9b59b6",
       "width": 400,
       "height": 300
     },
     "params": {
       "iterations": {
         "type": "int",
         "default": "1",
         "position": "top"
       }
     }
   }

Subflow stereotypes define **containers** that hold an entire sub-graph (nodes
with ``parentId`` set to the subflow node). The ``pythonClassName`` references
a structural operation that runs or transforms the sub-graph. Subflows use
``_recursive_: false`` in the generated Hydra config to prevent recursive
instantiation.

Observable: ActivationStatistics
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. code-block:: json

   {
     "category": "Observable",
     "pythonClassName": "interpretability.ActivationStatistics",
     "view": {"color": "#7c3aed", "width": 210, "height": 100},
     "observable": {
       "captureKind": "FORWARD_VALUE",
       "supportedModes": ["TRAIN", "EVAL"],
       "finalizePhase": "POST_EPOCH",
       "defaultRetentionScope": "EPOCH",
       "supportedRetentionScopes": ["BATCH", "EPOCH", "RUN"],
       "defaultStorageStrategy": "STREAMING",
       "supportedStorageStrategies": ["STREAMING"],
       "inputs": [{"id": "in-0", "label": "activation", "required": true}],
       "resultSchema": {
         "kind": "statistics",
         "fields": ["count", "mean", "variance", "norm", "sparsity"]
       }
     },
     "params": {
       "execution_modes": {"type": "str", "default": "['TRAIN', 'EVAL']"},
       "retention_scope": {"type": "str", "default": "EPOCH"},
       "storage_strategy": {"type": "str", "default": "STREAMING"},
       "wandb_table_name": {"type": "str", "default": ""}
     },
     "type_signature": {
       "kind": "observable",
       "input": [[{"kind": "wildcard"}]]
     }
   }

Observable stereotypes live in ``Stereotypes/Observables/``. Their target
handles are fixed by ``observable.inputs`` and ordered by identifiers such as
``in-0``. The normal computational source handle is the public ``out`` point;
an Observable has no source handle and its result cannot connect to a model
node. ``ActivationRecorder`` is the other initial stereotype: it supports
``TRAIN``, ``EVAL`` and ``PREDICT``, defaults to sampled run retention, and
records tensor references. ``GradientStatistics``, internal QKV points, and
CKA analyses are deferred rather than implied by this schema.

Notes
-----

* **Loss nodes** determine task type for metric selection: ``CrossEntropyLoss``
  and ``BCEWithLogitsLoss`` set classification, ``MSELoss`` sets regression.
  In the DSL a Loss is a layer with a conceptual rank-1 output ``[B]`` and the
  editor keeps its output handle so the inferred type can be inspected. The
  current ``converted/`` backend still extracts Loss nodes as terminal training
  objectives. Executing and propagating this conceptual output in the backend
  is planned future work.

* **Flatten is explicit**: there is no auto-flatten heuristic in the forward
  pass. You must insert a Flatten node when transitioning from convolutional
  to linear layers.

* **Unflatten uses param_spread**: the ``Unflatten`` module expands a
  flattened dimension back into multiple dimensions using a tuple parameter
  (``unflattened_size``). The type system models this via the ``param_spread``
  pattern kind, which reads the tuple and produces multiple output dimensions.

* **HorizontalRepeat** has its join hardcoded to concat on ``dim=-1``. Output
  shape becomes ``[batch, ..., n * d]``. This is not configurable.

* **Join input order** matters for non-commutative joins like ``MatMul`` and
  ``ScaledDotProduct``. The order is determined by the ``targetHandle`` labels
  (``"in-0"``, ``"in-1"``, ...), not by BFS traversal.

* **Parameter display positions**: ``"top"`` renders above the node's center,
  ``"bottom"`` below, omitted renders in the sidebar's parameter panel only.
