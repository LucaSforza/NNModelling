Tutorial: build a Dense ReLU layer
==================================

This tutorial creates a project-owned stereotype called **Dense ReLU**. It
combines a trainable affine transformation and a ReLU activation in one node:

.. math::

   y = \max(0, xW^T + b)

You will define the node's parameters, describe its tensor types in Lua, and
implement its computation in PyTorch. NNModelling loads these files as a
package; no editor source changes or central registration table are needed.

The example accepts float32 tensors and transforms only the last dimension:

.. code-block:: text

   in_features = 8, out_features = 4
   [B, 8]    float32 -> [B, 4]    float32
   [B, T, 8] float32 -> [B, T, 4] float32

``B`` and ``T`` may remain symbolic. The last input dimension must be known
and equal ``in_features``. This deliberately small example supports only
float32; it does not cast other dtypes or flatten images automatically.

1. Create the package directory
-------------------------------

Open a writable project, then open **Stereotypes** and create a custom
stereotype with these values:

.. list-table::
   :header-rows: 1
   :widths: 35 65

   * - Field
     - Value
   * - Package ID
     - ``tutorial.dense-relu``
   * - Version
     - ``0.1.0``
   * - Name
     - ``Dense ReLU``
   * - Kind
     - ``layer``

Add ``in_features`` and ``out_features`` as integer parameters with minimum 1,
positioned at the top and bottom respectively. Add ``bias`` as a boolean with
default ``true`` and bottom position. Leave dependencies empty.

Creation adds an entry to the model manifest and generates four files. Locate
the directory recorded in ``model.json``'s ``manifest.customPackages``. Wait
for the project to save, close it, then replace those four generated files with
the complete sources below. Reopen the project after editing them.

Alternatively, with the project closed, create ``packages/dense-relu/``
manually and put the same four files there:

.. code-block:: text

   my-project/
   ├── model.json
   └── packages/
       └── dense-relu/
           ├── manifest.json
           ├── stereotype.json
           ├── inference.lua
           └── pytorch.py

For manual creation, append this entry to the existing
``manifest.customPackages`` array in ``model.json``:

.. code-block:: json

   {
     "id": "tutorial.dense-relu",
     "version": "0.1.0",
     "path": "packages/dense-relu"
   }

This is one array entry, not a replacement for ``model.json``. Preserve the
existing model identity, nodes, edges, datasets and other package references.
If you used the form, it already added the entry: use its generated path
rather than adding a duplicate. A directory alone does not register a package;
the model must declare it.

2. Declare identity and entrypoints
-----------------------------------

Save this as ``manifest.json``:

.. literalinclude:: _examples/dense-relu/manifest.json
   :language: json

:download:`Download manifest.json <_examples/dense-relu/manifest.json>`.

The manifest connects package identity to its definition, Lua rule and Python
builder. All file paths are relative to this package directory. The ID/version
must match the reference in the model manifest.

``dependencies`` lists other stereotype packages used by package composition.
It is empty here because the Python builder uses PyTorch's ``Linear`` and
``ReLU`` directly. Using those Python classes does not create dependencies on
``core.linear`` or ``core.relu``. This field is not a pip or npm dependency list.

3. Define the node and parameters
---------------------------------

Save this as ``stereotype.json``:

.. literalinclude:: _examples/dense-relu/stereotype.json
   :language: json

:download:`Download stereotype.json <_examples/dense-relu/stereotype.json>`.

``kind: "layer"`` selects a node with one graph tensor input. ``view`` controls
its appearance; it does not affect computation. The parameter schema drives
validation and the editor's controls:

* ``in_features`` and ``out_features`` are positive integers. They have no
  defaults, so the user must supply them before inference can complete.
* ``bias`` defaults to ``true``. It controls whether Linear creates a trainable
  bias vector.
* ``position`` places a parameter in the node UI; it has no tensor meaning.

Node values are primitives such as
``{"in_features": 8, "out_features": 4, "bias": true}``. Do not wrap them in
objects containing ``value`` or ``position``.

These settings are architecture parameters. The learned weight matrix and bias
are PyTorch module parameters created by the builder, not values entered into
the node's parameter form.

4. Infer shapes and dtypes in Lua
---------------------------------

Save this as ``inference.lua``:

.. literalinclude:: _examples/dense-relu/inference.lua
   :language: lua

:download:`Download inference.lua <_examples/dense-relu/inference.lua>`.

The file returns a function called by the frontend runtime:

``context``
   Supplies the tensor context for this node kind. A layer's one input is
   ``context.inputs[1]``; Lua arrays use one-based indexing.
``parameters``
   Contains validated primitive settings, including applied defaults. Missing
   required settings or unavailable upstream types leave editor inference
   unresolved before this rule can produce a result.
``services``
   Provides host-managed composition operations when a package needs them.
   This layer has no nested graph or referenced stereotype, so it does not
   call a service.

``tensor`` is the helper API supplied by the Lua runtime, not PyTorch and not
an extra dependency to import. Each helper used above returns a value and an
optional error message. ``tensor.dimension(input, -1)`` reads the last axis;
``tensor.with_dimension`` creates the output tensor type while preserving all
other dimensions and the dtype.

The rule first rejects non-float32 input, then checks the feature dimension.
On success, it replaces only the last dimension. ReLU does not change that
output shape or dtype. The rule describes the computation but does not run it,
allocate weights, inspect training data or calculate tensor values.

Return ``status = "error"`` for an expected incompatibility, such as 16 input
features when the node expects 8. A broken Lua program is instead a runtime
fault. Do not return a fabricated tensor to hide either condition. See
:doc:`type_system` for the inference states.

5. Build the PyTorch computation
--------------------------------

Save this as ``pytorch.py``:

.. literalinclude:: _examples/dense-relu/pytorch.py
   :language: python

:download:`Download pytorch.py <_examples/dense-relu/pytorch.py>`.

``build(parameters, context, services)`` returns a ``torch.nn.Module`` for one
graph node. The runtime supplies ``stereotype_runtime.pytorch``; your project
does not need to copy that module into its package directory.

The builder creates Linear's weights once, then wraps Linear and ReLU in
``Sequential``. The resulting module can participate in autograd, optimizer
updates and state-dict export. Never create a new Linear layer on every forward
call: that would replace the learned parameters every time.

The explicit ``dtype=torch.float32`` matches the Lua contract. ``context`` and
``services`` are unused here, so ``NoServices`` documents that fact. The builder
does not choose a GPU or start its own training loop; the worker manages device
placement and training.

The two implementations must agree:

.. list-table::
   :header-rows: 1
   :widths: 50 50

   * - Lua contract
     - PyTorch behavior
   * - Last dimension must equal ``in_features``.
     - Linear expects that many input features.
   * - Last dimension becomes ``out_features``.
     - Linear produces that many output features.
   * - Float32 input and output.
     - Linear has float32 weights; ReLU preserves dtype.
   * - Leading dimensions are preserved.
     - Linear and ReLU operate over the last dimension.

In the supported training flow, the browser transports ``pytorch.py`` with the
package bundle. FastAPI validates the bundle without importing that Python;
execution takes place in the isolated worker. The prediction wheel retains
the required package resources and trained weights.

6. Load and exercise the layer
------------------------------

Reopen the project so the runtime reads the edited files. **Dense ReLU** should
appear in the current project's stereotypes and palette. Add it to the graph,
set ``in_features`` and ``out_features``, and connect an upstream tensor.

For a quick editor check using a copied MNIST example from :doc:`examples`,
select its project dataset and connect:

.. code-block:: text

   Input (binding=image) -> Flatten -> Dense ReLU -> Output
   [B, 1, 28, 28]          [B, 784]    [B, 32]      [B, 32]

Set Dense ReLU's ``in_features`` to 784 and ``out_features`` to 32. Flatten
must flatten the non-batch axes. This is a shape-checking graph, not a complete
training objective. For classification, add a final Linear producing 10 logits
and connect those logits to Output and Cross Entropy, as in the ResNet example.
Do not use Dense ReLU as the final logits layer: its activation removes negative
logits.

Useful checks before using a new package in a larger model:

.. list-table::
   :header-rows: 1
   :widths: 55 45

   * - Input or change
     - Expected result
   * - Float32 ``[B, 8]``, features 8 → 4
     - Float32 ``[B, 4]``
   * - Float32 ``[B, T, 8]``, features 8 → 4
     - Float32 ``[B, T, 4]``
   * - Float32 ``[B, 16]``, features 8 → 4
     - Feature mismatch error
   * - Float64 ``[B, 8]``
     - Dtype error; no implicit cast
   * - Symbolic last axis ``[B, F]`` with ``in_features=8``
     - Error; the rule cannot assume ``F`` equals 8
   * - Missing ``out_features``
     - Unresolved required parameter

Also exercise the module with real tensors: input ``[2, 8]`` must produce
``[2, 4]`` with nonnegative values, and backpropagation must reach Linear's
weights. Setting ``bias=false`` must remove its bias parameter. Static shape
inference alone cannot prove these numerical properties.

How the stereotype plugin system loads it
-----------------------------------------

The project manifest declares which custom packages are available. The host
validates their files and dependencies, then activates their definitions and
Lua rules through its Cordis-backed runtime. Each package has its own lifecycle
and inference environment. Switching projects replaces the custom package
scope; immutable core packages remain available.

You provide package resources, not a JavaScript Cordis plugin or a Python class
name in a central registry. The same exact ID/version connects the palette
entry, graph node, Lua rule and exported Python builder.

To compose other stereotypes instead of using PyTorch classes directly,
declare their package dependencies and use the corresponding host services:
``services.infer_stereotype(...)`` in Lua and
``services.build_stereotype(...)`` in Python. Subflow packages use
``infer_subflow`` and ``build_subflow`` for their child graphs. Both sides must
express the same composition; do not add package-ID dispatch to the editor.

For another new layer, reuse this four-file layout, choose a new package ID,
change the parameter schema, and update both its Lua contract and PyTorch
implementation. See :doc:`stereotypes` for package kinds and deletion rules.
