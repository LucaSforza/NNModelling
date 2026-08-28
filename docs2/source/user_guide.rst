User guide
==========

Create package graphs in the browser using the package catalog. ``DiagramCore``
is the authoritative graph model and package definitions provide parameters,
tensor contracts and isolated Lua type inference.

Graph editing
-------------

The editor requires one top-level package Input. Connect package nodes using
ordered join handles (``in-0``, ``in-1``). Missing inputs and invalid parameters
remain explicit type errors; they are not silently inferred by a backend.

Save and exchange
-----------------

Use the editor's package diagram serialization to save editable source graphs.
The MCP server exposes the same browser-owned serialization and graph tools; it
does not maintain a second graph or offer a legacy conversion command.

Training
--------

For training, add an explicit package Output for prediction and connect the
objective package to the prediction value it consumes. The Training sidebar
selects a registered dataset and typed optimizer, trainer, accelerator,
early-stopping and W&B settings. The browser uploads an authenticated package
bundle to FastAPI, which schedules a Podman/Docker worker.

After completion, download the portable Python wheel. It includes package
resources, graph metadata, the input adapter and ``safetensors`` weights and
can be used without this checkout. Targets are supplied by the dataset adapter
to the objective program and are not guessed from output shapes.
