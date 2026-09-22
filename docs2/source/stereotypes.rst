Create and use stereotypes
==========================

A stereotype is a reusable node definition packaged with tensor inference and
PyTorch behavior. Each package has an exact ID and version. The palette contains
core stereotypes plus the custom stereotypes declared by the active project.
Switching projects changes that custom scope.

For a complete example with downloadable source files, follow
:doc:`stereotype_tutorial`: a trainable Dense ReLU layer with parameter metadata,
Lua shape inference and a PyTorch builder.

Create a project stereotype
---------------------------

Open **Stereotypes** and create a custom stereotype. The form collects its
identity, display metadata, kind, dependencies and parameters. Each parameter
needs a unique name, a supported type and an explicit top or bottom display
position.

Creation writes ordinary files inside the project and adds the package to
``manifest.customPackages``:

.. code-block:: text

   packages/my-layer/
   ├── manifest.json
   ├── stereotype.json
   ├── inference.lua
   └── pytorch.py

``manifest.json``
   Exact package identity, dependencies and resource entrypoints.
``stereotype.json``
   Node kind, parameter schema and presentation metadata.
``inference.lua``
   Frontend tensor inference executed in the isolated Lua runtime.
``pytorch.py``
   The builder executed by the isolated backend worker.

A generated layer starts with pass-through Lua inference and a PyTorch
``Identity`` builder. Replace both when implementing a real transformation:
changing a display name or adding a parameter does not implement its
mathematics. Keep the inferred output contract consistent with the Python
module's actual behavior.

Edit the generated files with your code editor, then reopen the project to load
external changes. Inspect package diagnostics and test a representative tensor
path before training. Core stereotypes are immutable; custom source belongs to
the project rather than a global browser installation.

Package kinds
-------------

``input``
   Names a top-level dataset input through ``params.binding``. Inside a subflow,
   a declared input boundary instead receives its enclosing tensor context.
``layer``
   Transforms one graph tensor.
``join``
   Combines tensors in target-handle order (``in-0``, ``in-1``, ...).
``subflow``
   Composes a child graph while retaining its containment boundaries.
``output``
   Marks the prediction value exported by a trainable graph.
``loss``
   Computes an objective from graph predictions and declared external target
   bindings. Dataset targets are separate from ordinary graph edges.

Inference and runtime behavior
------------------------------

The frontend invokes package-owned Lua using parameters and input tensor
context. A successful result has a shape and canonical dtype. Missing inputs
or required parameters may leave the region unresolved; semantic errors and
runtime faults remain distinct. See :doc:`type_system`.

Python is not a fallback type checker. FastAPI does not import uploaded
builders or dataset code; execution belongs to the worker container. Package
behavior must be defined in its resources, not a special-case package-ID branch
in the editor or backend.

Remove a stereotype
-------------------

Only project-owned stereotypes can be deleted. First remove graph nodes using
that exact package identity and resolve dependencies from other project
packages. Deletion is rejected while either reference remains; it does not
cascade through your graph. A successful deletion removes the manifest entry,
package directory and active catalog entry.
