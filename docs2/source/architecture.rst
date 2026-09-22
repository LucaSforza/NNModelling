Architecture
============

NNModelling separates interactive graph editing, isolated training and portable
prediction. The same Svelte editor runs in a web browser or the Electron Linux
desktop host.

.. code-block:: text

   writable project: model.json + custom packages + datasets
                                  |
                                  v
                  editor: DiagramCore + Lua inference
                          |                   |
                          |              browser-backed MCP
                          v
                 authenticated package and dataset uploads
                          |
                          v
                   FastAPI + Valkey
                          |
                          v
                 container controller -> worker
                                           |
                                           v
                              artifacts + prediction wheel

Component responsibilities
--------------------------

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Component
     - Owns
   * - ``front-end/``
     - Live graph, editing history, project persistence, package activation,
       tensor inference and browser training controls.
   * - ``desktop/`` and ``flatpak/``
     - Desktop host, directory access and Linux packaging of the shared editor.
   * - ``stereotype-packages/``
     - Shared core package definitions, Lua rules and PyTorch builders.
   * - ``mcp-server/``
     - Tool transport to the selected editor, plus separate compatibility
       HTTP training clients.
   * - ``converted/``
     - Package compilation, authenticated API, scheduling, worker execution
       and model wheel export.

One live graph
--------------

The active renderer's ``DiagramCore`` owns nodes, edges, parameters,
containment and history. Neither Electron's main process nor the MCP server
keeps a second graph. Nodes persist exact package IDs and versions; display
names are supplied by the runtime catalog.

The current model manifest declares the complete custom package and dataset
scope. Core packages remain available across projects. Opening another project
stages its resources and replaces the previous custom scope. Filesystem handles
and absolute host paths are not serialized into model JSON or backend requests.

Package definitions drive topology, parameters and presentation. Lua rules own
tensor semantics; the frontend never invokes PyTorch to infer shapes.
See :doc:`type_system` and :doc:`stereotypes`.

MCP integration
---------------

Graph and selected-editor training operations follow the browser bridge:

.. code-block:: text

   MCP stdio -> BrowserRPCClient -> BrowserRPCHandler
                               -> DiagramCore / TrainingController

An editor tab must be connected and selected before these tools can work.
With multiple tabs, select the intended one explicitly. The MCP process does
not create an independent graph or package catalog.

Validation tools have limited scopes: ``validate_graph`` checks selected
topology rules, and connection/subflow validation can report
``supported: false``. A topology check does not replace Lua type inference or
worker validation.

Selected-editor training tools share the browser's paired connection. Legacy
compatibility training tools use a separately configured HTTP client and can
have different ownership. These identities are not interchangeable.

Training boundary
-----------------

The browser uploads an immutable ``package-bundle/v1`` and a separate project
dataset archive. FastAPI validates typed metadata, digest and ownership, then
queues the job in Valkey. It does not execute uploaded Python.

Valkey holds persistent queue, session, heartbeat and event state. The controller
starts a short-lived worker container with read-only inputs, bounded resources
and the configured network policy. There is no host-Python fallback.

The compiler creates prediction and objective programs over shared modules.
Dataset loaders produce named input and target tensors. The prediction program
needs only inputs; the objective receives its declared target bindings.

The resulting wheel includes the prediction graph, package resources,
safetensors weights and selected adapters. It can run outside the repository
without the training dataset. See :doc:`python_api` for its consumer interface
and :doc:`training_admin_guide` for operating the backend.
