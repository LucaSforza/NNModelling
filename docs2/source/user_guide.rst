User guide
==========

Create package graphs in the browser using the package catalog. ``DiagramCore``
is the authoritative graph model and package definitions provide parameters,
tensor contracts and isolated Lua type inference.

Graph editing
-------------

Top-level models may have one or more package ``Input`` nodes. Each Input's
``params.binding`` names a slot in the selected dataset's ``batch.inputs``
contract; the dataset supplies its shape and dtype. Input nodes do not declare
their own shape or dtype. Select a dataset before expecting complete inference
for regions that depend on those inputs. Internal subflow boundaries inherit
their type from the enclosing graph rather than binding dataset slots.

Use a ``layer`` for a single tensor input and a ``join`` for multiple inputs.
Join operands are ordered by their target handles (``in-0``, ``in-1``, ...).
Missing dataset information or required parameters leaves affected regions
unresolved; semantic incompatibilities are errors, and runtime faults are
reported separately.

Save and exchange
-----------------

Use the editor's package diagram serialization to save editable source graphs.
The MCP server exposes the same browser-owned serialization and graph tools; it
does not maintain a second graph or offer a legacy conversion command.

Training
--------

For training, add an explicit package Output for prediction and connect the
objective package to the prediction value it consumes. The Training sidebar
selects a registered dataset and its declared settings, then typed optimizer,
trainer, accelerator, early-stopping and W&B settings. The browser uploads an
authenticated package bundle to FastAPI, which schedules a Podman/Docker worker.

After completion, download the portable Python wheel. It includes package
resources, graph metadata, the input adapter and ``safetensors`` weights and
can be used without this checkout. Targets are supplied by the dataset adapter
to the objective program and are not guessed from output shapes. For a model
with multiple named inputs, pass a tensor map to ``predict_tensor``.
