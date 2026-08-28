Architecture
============

Browser ownership
-----------------

The browser's ``DiagramCore`` is the sole authority for nodes, edges,
parameters, containment and history. Package definitions and Lua inference are
loaded in the browser. Every node has an exact package identifier and version.

The MCP server only forwards requests:

.. code-block:: text

   MCP stdio -> BrowserRPCClient -> BrowserRPCHandler -> DiagramCore

It keeps no graph mirror and exposes package graph inspection, mutation,
serialization and validation as narrow browser proxies.

Backend boundary
----------------

The browser uploads an authenticated immutable ``package-bundle/v1`` to
FastAPI. The API validates the typed graph and training request, stores
ownership metadata and queues a job in Valkey. A Podman or Docker controller
starts one short-lived worker container. Uploaded package Python is never
imported by FastAPI.

.. code-block:: text

   FastAPI -> Valkey scheduler -> container controller
          -> package worker -> artifacts and portable wheel

The compiler produces prediction and objective programs over one shared module
store. Dataset adapters provide ``(inputs, targets)`` to the objective program;
the prediction program never requires training targets. The wheel contains the
package graph, resources, input adapter metadata and ``safetensors`` weights and
can be installed without this repository.

Security
--------

The API process has no authority to execute uploaded package code. Workers use
least-privilege mounts, bounded resources, network policy and an explicit
runtime image. Container execution is the only package-job executor; there is

no host-Python fallback.
