TypeScript / Frontend API Reference
===================================

The frontend TypeScript API is documented using **TypeDoc**. The generated
documentation is available as a static site.

Viewing the TypeScript API
--------------------------

After running ``pnpm run docs`` from the repository root, open the `generated TypeDoc site <../typedoc/index.html>`_, or its local file:

.. code-block:: text

   docs2/build/typedoc/index.html

The current entry points document the following public symbols:

* ``DiagramCore`` — main state authority with all graph manipulation methods
* ``BrowserRPCHandler`` — WebSocket RPC handler for MCP integration
* ``checkValidConnection`` — standalone connection validation
* ``findDirectedCycle`` — cycle detection over directed graph edges
* ``Position``, ``NodeConfig``, ``JoinNodeConfig``, ``DiagramCoreSnapshot`` —
  core type definitions

The retired ``StereotypeCore`` loader is not part of the current API; packages
are activated through the package type-system runtime.

Generating the TypeScript API
-----------------------------

To regenerate only the TypeDoc output:

.. code-block:: bash

   pnpm run docs:typedoc

To regenerate both TypeDoc and Sphinx:

.. code-block:: bash

   pnpm run docs

Architecture Overview
---------------------

The TypeScript API documentation is generated from ``src/core/index.ts`` and
``src/sync/index.ts``. The core barrel exports ``DiagramCore``, selected core
types and graph-validation functions; the sync barrel exports
``BrowserRPCHandler``.

The TypeScript codebase is organized into two layers:

**core/** (TypeScript graph core)
    These modules contain the editor's graph business logic without Svelte
    components. Their public node and edge types use Svelte Flow types:

    * ``DiagramCore`` — manages nodes, edges, undo/redo, import/export, and
      exposes the synchronous ``onGraphChanged`` graph-change subscription
    * ``types.ts`` — shared type definitions (``Position``, ``NodeConfig``,
      ``JoinNodeConfig``, ``DiagramCoreSnapshot``)
    * ``validation.ts`` — connection validation rules and cycle detection
      (``checkValidConnection``, ``findDirectedCycle``)

**sync/** (Browser-Side RPC)
    * ``BrowserRPCHandler`` — handles WebSocket JSON-RPC requests from the
      MCP server, executing methods on the local ``DiagramCore``

Key Types
---------

The ``core`` barrel exports these configuration and snapshot types (the
``types.ts`` module also re-exports ``Node`` and ``Edge`` from Svelte Flow):

.. code-block:: typescript

   interface Position {
     x: number;
     y: number;
   }

   interface NodeConfig {
     name?: string;
     color?: string;
     width?: number;
     height?: number;
     params?: Record<string, unknown>;
   }

   interface JoinNodeConfig extends NodeConfig {
     inputsCount?: number;
   }

   interface DiagramCoreSnapshot {
     nodes: Node[];
     edges: Edge[];
     layoutDirection: LayoutDirection;
     manifest: ModelManifest;
   }

``DiagramCore`` also exposes the synchronous ``onGraphChanged(handler)``
graph-change subscription: the handler runs once after every successful public
mutation (add/update/delete/move operations, edge changes, undo/redo, snapshot
restore, import and reset), carries no payload, and returns an unsubscribe
function. Rejected connections and no-op operations do not notify. Mutating
the graph from inside a notification is rejected; schedule follow-up edits
outside the callback. Listener exceptions are caught and logged.

TypeDoc documents the selected public entry points. Types referenced from
other modules may appear in signatures without having standalone pages; consult
their source definitions for those supporting types.
