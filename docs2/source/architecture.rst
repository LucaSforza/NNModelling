Architecture
============

NNModelling is designed around a **decoupled, three-package architecture**
where the visual editor, code generation, and agent interface each live in
their own package with clear boundaries.

.. code-block:: text

   ┌─────────────────────────────────────────────────────────────────┐
   │                    Browser (User Interface)                      │
   │                                                                   │
   │  ┌──────────┐  ┌──────────────┐  ┌──────────────┐              │
   │  │ FlowCanvas│  │   Sidebar    │  │ CustomNode   │              │
   │  │ (Svelte)  │  │   (Svelte)   │  │ JoinNode     │  .svelte    │
   │  │           │  │              │  │ SubflowNode   │  files      │
   │  └─────┬─────┘  └──────┬───────┘  └──────┬───────┘              │
   │        │               │                 │                       │
   │        └───────┬───────┴─────────────────┘                       │
   │                │                                                  │
   │        ┌───────▼──────────────────────────┐                      │
   │        │       Diagram.svelte.ts           │  Thin Svelte        │
   │        │  ($state.raw reactive wrapper)    │  wrapper (thin)     │
   │        └───────────────┬──────────────────┘                      │
   │                        │                                          │
   │        ┌───────────────▼──────────────────┐                      │
   │        │       core/DiagramCore.ts         │  Pure TypeScript     │
   │        │  - Nodes & edges (plain arrays)  │  (Zero Svelte deps)  │
   │        │  - Business logic                 │                      │
   │        │  - onGraphChanged graph signal    │                      │
   │        │  - Undo/redo (snapshot-based)     │                      │
   │        └───────────────┬──────────────────┘                      │
   │                        │                                          │
   │        ┌───────────────▼──────────────────┐                      │
   │        │  sync/BrowserRPCHandler.ts       │  WebSocket RPC       │
   │        │  - Receives RPC requests          │  handler             │
   │        │  - Executes on DiagramCore        │                      │
   │        │  - Returns results as JSON        │                      │
   │        └───────────────┬──────────────────┘                      │
   └────────────────────────┼──────────────────────────────────────────┘
                            │  WebSocket (ws://localhost:9339)
   ┌────────────────────────▼──────────────────────────────────────────┐
   │                       MCP Server                                   │
   │                                                                   │
   │  ┌─────────────────────┐  ┌────────────────────┐                 │
   │  │  browser-client.ts  │  │  tools/             │                 │
   │  │  WebSocket RPC      │  │  ├── graph.ts       │                 │
   │  │  (multi-tab)        │  │  ├── parameters.ts  │                 │
   │  └─────────┬───────────┘  │  ├── selection.ts   │                 │
   │            │              │  ├── canvas.ts      │                 │
   │            │              │  ├── validation.ts  │                 │
   │            │              │  ├── conversion.ts  │                 │
   │            │              │  ├── inspection.ts  │                 │
   │            │              │  ├── connection.ts  │                 │
   │            │              │  └── lifecycle.ts   │                 │
   │            │              └────────────────────┘                 │
   │            │                                                      │
   │  ┌─────────▼───────────┐  ┌────────────────────┐                 │
   │  │    server.ts         │  │    pipeline.ts      │                 │
   │  │    MCP stdio setup   │  │    Python subprocess│                 │
   │  └─────────────────────┘  └────────────────────┘                 │
   └────────────────────────┬──────────────────────────────────────────┘
                            │  subprocess (uv run python)
   ┌────────────────────────▼──────────────────────────────────────────┐
   │                  Python Backend                                     │
   │                                                                     │
   │  convert.py  ──►  Hydra YAML Configs                                │
   │                            │                                         │
   │                     main.py ──► Training (Lightning)                │
   │                            │                                         │
   │                     infer.py ──► Inference + Predictions            │
   └─────────────────────────────────────────────────────────────────────┘

Design Philosophy
-----------------

The architecture follows three key principles:

1. **Single source of truth** — All diagram state lives in the browser's
   ``DiagramCore``. The MCP server is a thin proxy that queries the browser
   via RPC; it holds no state of its own.
2. **Pure TypeScript core** — ``DiagramCore``, ``StereotypeCore``,
   and ``validation`` have zero Svelte or DOM dependencies. They can run in
   any JavaScript environment (browser, Node.js, tests).
3. **Standard output** — The pipeline produces standard PyTorch code and
   Hydra configs. There is no proprietary runtime — once trained, the model
   is pure PyTorch/Lightning.

Core Packages
-------------

### front-end/ (Svelte 5 + Svelte Flow)

The visual editor is built with Svelte 5's runes-based reactivity (``$state``,
``$derived``, ``$effect``). It uses `Svelte Flow <https://svelteflow.dev>`_
for the interactive canvas.

**Key source files:**

+-----------------------------+-----------------------------------------+
| File                        | Purpose                                 |
+=============================+=========================================+
| ``App.svelte``              | Mount point, wraps SvelteFlowProvider   |
+-----------------------------+-----------------------------------------+
| ``FlowCanvas.svelte``       | Main canvas, toolbar, keyboard          |
+-----------------------------+-----------------------------------------+
| ``Sidebar.svelte``          | Node create/edit form                   |
+-----------------------------+-----------------------------------------+
| ``CustomNode.svelte``       | Standard NN module node                 |
+-----------------------------+-----------------------------------------+
| ``JoinNode.svelte``         | Multi-input merge node                  |
+-----------------------------+-----------------------------------------+
| ``SubflowNode.svelte``      | Collapsible container                   |
+-----------------------------+-----------------------------------------+

### core/ (Pure TypeScript)

This is the heart of the frontend logic, written with zero Svelte dependencies.

``DiagramCore``
    The main state authority. Holds ``nodes`` and ``edges`` as plain arrays.
    All business logic lives here:

    * ``addModule()``, ``addJoinNode()``, ``addSubGraph()``
    * ``deleteNodes()``, ``addEdge()``, ``moveNode()``, ``moveNodes()``
    * ``importFromJson()``, ``exportToJson()``
    * ``toggleSubflow()``, ``undo()``, ``redo()``
    * Snapshot-based undo/redo with 50-entry stack

``DiagramCore.onGraphChanged``
    The single graph-change notification contract. ``onGraphChanged(handler)``
    subscribes a synchronous callback that is invoked once after every
    successful public mutation — add/update/delete/move operations, edge
    changes, undo/redo, snapshot restore, import and reset. Rejected
    connections and no-op operations do not notify, and the callback carries
    no payload (there is no event replay or catch-all bus). The returned
    function unsubscribes; unsubscribing is safe even from inside a handler.
    ``Diagram.svelte.ts`` and ``FlowCanvas.svelte`` use this signal to force
    Svelte reactivity, refresh type inference and re-fit the viewport after
    RPC-driven mutations.

``StereotypeCore``
    Loads stereotype definitions from JSON files in the browser via Vite's
    ``import.meta.glob`` (``Stereotypes/`` directory). The MCP server does not
    import the frontend loader: it keeps its own local ESM-safe projection of
    the same JSON files, exposing only the fields the server needs
    (``mcp-server/src/server.ts``).

``validation``
    Standalone connection validation logic that checks:

    * Each target handle has only one incoming connection
    * No duplicate connections
    * No self-connections (cycles)

### sync/ (Browser-Side RPC)

``BrowserRPCHandler``
    Listens on a WebSocket for JSON-RPC requests from the MCP server.
    Each request specifies a method (e.g. ``create_node``, ``delete_nodes``,
    ``get_graph``) and parameters. The handler executes the method on the
    local ``DiagramCore`` instance and returns the result.

    Supports **multi-tab** scenarios — multiple browser windows can connect
    to the same MCP server. Each gets a sequential tab ID (``tab_1``,
    ``tab_2``, ...).

### conversion/ (NNTree Compiler)

``nnTree.ts``
    Converts the visual graph into a formal **NNTree representation**.
    This is the bridge between the visual editor and the Python backend.

    The compiler handles:

    * **Sequential chains** — linear paths through the graph become
      ``Sequential`` blocks
    * **Joins** — nodes with multiple parents become ``join`` type nodes
      with explicit input ordering
    * **Subflows** — container nodes become ``subflow`` type entries with
      internal ``nodes`` map (preserving graph topology)
    * **Nested subflows** — recursive ``compileSubflowGraph`` for arbitrary
      nesting depth
    * **Repeat unrolling** — ``Repeat`` stereotypes are compiled to
      sequential copies
    * **Loss nodes** — identified by stereotype category (``Loss``), they
      expose a conceptual rank-1 ``[B]`` output in the editor and set the task
      type for metric selection. The current Python backend still extracts them
      as terminal objectives; runtime output propagation is future work.

### mcp-server/ (Thin Proxy)

The MCP server is deliberately **thin** — it does NOT hold its own
``DiagramCore``. All state lives in the browser.

**Communication flow:**

1. LLM agent sends an MCP tool call (e.g. ``create_node``) via stdio
2. ``server.ts`` routes to the appropriate tool handler
3. The tool handler sends a JSON-RPC request via WebSocket to the browser
4. ``BrowserRPCHandler`` executes the method on ``DiagramCore``
5. The result flows back: Browser → WebSocket → MCP Server → LLM Agent

**Multi-tab support:**

* Each browser tab gets a unique ID when it connects
* ``list_browser_tabs`` returns all connected tabs
* ``select_browser_tab`` switches the active tab for subsequent operations
* Tab IDs are sequential and stable per connection

**Error handling:**

The server defines 4 error classes:

+---------------------------+-------------------------------------------------+
| Error                     | Purpose                                         |
+===========================+=================================================+
| ``MCPServerError``        | Base class carrying error code and details      |
+---------------------------+-------------------------------------------------+
| ``ConversionFailedError`` | convert.py failed                               |
+---------------------------+-------------------------------------------------+
| ``TrainingFailedError``   | main.py training failed                         |
+---------------------------+-------------------------------------------------+
| ``InferenceFailedError``  | infer.py failed                                 |
+---------------------------+-------------------------------------------------+

### converted/ (Python Backend)

The Python package takes the NNTree JSON and produces executable PyTorch code.

``convert.py``
    Reads NNTree JSON and generates a directory of Hydra YAML configs.
    Uses ``ast.literal_eval`` for safe parameter parsing. Builds
    ``_target_`` paths for Hydra's instantiation mechanism.

``net/base.py`` (``Net`` class)
    A ``LightningModule`` that:

    * Dynamically builds ``nn.ModuleDict`` from config nodes
    * Uses **topological sort** (BFS with in-degree tracking) for forward pass
    * Handles sequential chains, joins, subflows, and loss nodes
    * Detects ``taskType`` (classification vs regression) for metric selection
    * Join input ordering is preserved from diagram edges via ``targetHandle``
      (``in-0``, ``in-1``, ...)

``ops/`` — Custom operations
    Each join type and subflow behavior has its own operation module:

    * ``Addition`` — element-wise sum
    * ``Concat`` — ``torch.cat(tensors, dim)``
    * ``Einsum`` — ``torch.einsum(expr, tensors)``
    * ``MatMul`` — ``inputs[0] @ inputs[1]``
    * ``ScaledDotProduct`` — attention: ``Q · K^T · sqrt(1/d)``
    * ``MaskedScaledDotProduct`` — same with causal masking
    * ``Subflow`` — BFS execution of internal graph
    * ``Repeat`` — N sequential copies via ``nn.Sequential``
    * ``HorizontalRepeat`` — N parallel copies via ``vmap`` + ``functional_call``
    * ``PositionalEncoding`` — sinusoidal positional encoding table
    * ``SequencePool`` — mean pooling over sequence dimension

``dataset/`` — Dataset classes
    * ``mnist.py`` — MNIST image classification
    * ``autoencoder_mnist.py`` — MNIST for autoencoder (no flatten)
    * ``enron_spam.py`` — Text classification via HF datasets + transformers

``main.py``
    Training entry point. Uses Hydra for configuration, Lightning for
    training loop, wandb for logging. Supports early stopping, checkpointing,
    and configurable devices.

``infer.py``
    Inference entry point. Loads a trained checkpoint, runs the test set,
    and saves:

    * ``predictions.json`` — labels and probabilities for classification,
      reconstruction data for autoencoders
    * Per-sample image strips and a montage (``--image-dir``)

``backend/cli.py`` (local companion)
    The single local start command. It serves the built editor from
    ``front-end/dist`` on the same origin as the training API and starts the
    existing FastAPI app on localhost:

    .. code-block:: bash

       PYTHONPATH=converted/src uv run --project converted python -m backend.cli

    The command fails actionably when the frontend assets are missing or Valkey
    is unreachable. It never proxies or routes remote jobs.

``backend/static.py``
    Safe static serving of the built editor. Built assets are served with
    correct content types, non-API paths fall back to ``index.html`` (SPA
    behavior), traversal attempts are rejected, and ``/api`` paths are never
    rewritten to the editor — unknown API calls surface an API 404 instead.

    The same app exposes the project workspace endpoints both at the root
    (established contract) and under the ``/api`` prefix, which is how the
    built editor's same-origin ``ProjectApiClient`` reaches the companion in
    production. Root training endpoints (``/health``, ``/pairing``, ``/jobs``,
    ...) remain unchanged for the Training Sidebar.

Companion boundary and authority
--------------------------------

The companion is an extension of the existing FastAPI process — there is no
fourth proxy service. It adds project lifecycle, environment synchronization,
run storage, and static editor serving, while the browser remains the **live
diagram source of truth** and the MCP server stays a thin browser RPC proxy:

.. code-block:: text

   Browser (DiagramCore)  <-- WebSocket RPC -->  MCP server (thin proxy)
        |
        |  same origin: /api (project calls) + root /pairing,/jobs (training)
        v
   FastAPI companion (backend.app) -- local executor / Slurm --> runs/
        |
        v
   Valkey (sessions, queue, jobs)     front-end/dist (static editor)

The Training Sidebar keeps its explicit backend URL and pairing flow: it may
connect to the localhost companion or to an independently managed remote
backend. The companion does not route or duplicate training jobs.

Stereotype System
-----------------

Stereotypes define the behavior and appearance of node types. They are stored
as JSON files in three directories:

.. code-block:: text

   Stereotypes/
   ├── Modules/      # 27 node templates (Linear, Conv2d, ReLU, ...)
   ├── Joins/        # 6 merge operations (Addition, Concat, ...)
   └── SubFlows/     # 2 container templates (Repeat, HorizontalRepeat)

Each JSON defines:

* **category** — determines node behavior (Input, Layer, Join, Loss, etc.)
* **pythonClassName** — maps to the Python class (e.g. ``nn.Linear``)
* **params** — configurable parameters with type, default, and position
* **view** — visual properties (color, width, height)

The ``StereotypeCore`` class loads stereotype JSON in the browser via
``loadFromDirectory()`` (Vite's ``import.meta.glob``). The MCP server does not
import the frontend loader: it keeps its own local ESM-safe projection of the
same ``Stereotypes/`` JSON files, exposing only the fields the server needs
(``mcp-server/src/server.ts``).

Data Flow
---------

Here is how a node drag-and-drop operation flows through the system:

::

   User drags "Linear" from sidebar
       │
       ▼
   Sidebar.svelte ──► DiagramCore.addModule()
       │
       ▼
   DiagramCore:
     1. Creates node object (id, type, position, stereotype, params)
     2. Pushes to nodes array
     3. Calls _captureUndoState() (snapshot-based)
     4. Notifies graph-change subscribers synchronously via onGraphChanged()
       │
       ▼
   Diagram.svelte.ts ($state.raw)
     Reactivity triggers Svelte Flow re-render
       │
       ▼
   FlowCanvas.svelte
     New node appears on canvas

The same mutation is independently captured by undo/redo, sent to the MCP
server (if connected via BrowserRPCHandler), and used for NNTree compilation
on conversion.

Undo/Redo System
----------------

Undo/redo uses **snapshot-based** state capture:

1. Before each mutation, ``_captureUndoState()`` pushes a deep clone of the
   current state (via ``getSnapshot()``) onto ``_undoStack``
2. On ``undo()``: pop current state onto ``_redoStack``, restore previous
   state via ``restoreSnapshot()``
3. On ``redo()``: pop from ``_redoStack``, push current onto ``_undoStack``
4. Stack limit: 50 entries
5. New mutations clear the ``_redoStack`` (standard behavior)
6. Auto-spawned Input node is excluded from undo history

This approach avoids per-event revert functions — any state can be restored
from a snapshot, regardless of which mutations occurred between states.
