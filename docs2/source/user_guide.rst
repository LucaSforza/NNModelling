Working with projects and graphs
================================

A project is a writable directory containing a model and its custom resources.
Open or create one before editing; :doc:`getting_started` covers that first
step. The active project name comes from its model manifest.

Project files and saving
------------------------

.. code-block:: text

   my-project/
   ├── model.json
   ├── packages/          # custom stereotypes declared by this model
   └── datasets/          # datasets declared by this model

``model.json`` stores the editable graph and model metadata. Its manifest
lists custom package and dataset resources with exact IDs, versions and
relative paths. Core stereotypes are supplied by the application.

Accepted graph and metadata changes are saved automatically. Wait for the
saved state before closing the page or changing projects. If a write fails,
check directory permissions and the visible error; the failed state does not
mean your latest edits reached disk.

To back up or share a project, copy its whole directory. The normal editor
workflow uses **New project** and **Open project**, rather than standalone
JSON import/export. A training wheel is a different artifact: it runs a trained
prediction model and does not replace the editable project.

Changes made by another application are not watched automatically. Reopen the
project to load edits to package or dataset source files. Finish saving editor
changes before modifying the same files externally.

Build a graph
-------------

Use the stereotype palette to add nodes, edit their parameters and connect
output handles to input handles. The available stereotypes are the immutable
core set plus the custom packages declared by the current project.

* **Input:** set ``binding`` to a named dataset input slot. Shape and dtype
  come from the selected dataset, not independent Input settings.
* **Layer:** transforms one incoming tensor.
* **Join:** combines several incoming tensors. Operand order follows target
  handles ``in-0``, ``in-1``, and so on. This matters for operations such as
  matrix multiplication.
* **Subflow:** contains a child graph. Internal boundaries receive their
  tensor context from the enclosing graph. Collapsing a subflow only changes
  its display; its children still participate in inference and compilation.
* **Output:** marks the prediction result exported by a trainable model.
* **Loss:** consumes prediction values and any declared dataset targets to
  compute an objective.

A top-level model can have multiple Input nodes with distinct dataset bindings.
A Fork passes an existing tensor through an internal graph; it does not replace
an external Input. Connections must remain in the same immediate containment
scope, so use subflow boundaries when crossing into a child graph.

Use the editor's undo/redo and layout controls while arranging the graph.
Positions, edge routes and collapsed display state do not change its tensor
semantics.

Inspect tensor types
--------------------

Choose a project dataset and fill its declared parameters to resolve
Input-dependent types. Inspect node diagnostics as you edit:

* **Unresolved:** a required dataset binding, parameter or upstream type is
  missing. Complete that information before treating the graph as ready.
* **Error:** a package rejected a shape, dtype or other semantic combination.
* **Fault:** a package could not activate or its Lua rule failed to execute.

The editor evaluates package-owned Lua rules locally; it does not run PyTorch
for shape inference. Static type success does not validate your dataset's
Python implementation or guarantee that training will succeed.

See :doc:`type_system` for symbolic dimensions and dtype rules,
:doc:`stereotypes` for custom layers, and :doc:`datasets` for dataset authoring.

Train and export
----------------

Connect the prediction value to an explicit Output and to the objective that
consumes it. Dataset target bindings feed the objective separately; they are
not prediction inputs. Follow :doc:`training_user_guide` to pair a backend,
configure the job and download its wheel.
