User Guide
==========

What is NNModelling?
--------------------

NNModelling is a **Domain-Specific Language (DSL)** that lets you design neural
networks visually using a node editor and automatically compiles those designs
into production-ready PyTorch code.

Think of it as a bridge between **visual thinking** and **production code**.
Instead of writing boilerplate by hand, you drag modules onto a canvas, connect
them to define the data flow, configure parameters, and let the tool generate
the complete training pipeline.

Why visual network design?
--------------------------

Designing neural architectures is inherently a **spatial and topological**
activity — you think about how data flows from one transformation to the next,
how branches merge, how skip connections carry information across layers.
A visual canvas maps directly to how you think about the network, while
text code forces you to maintain a mental model of the topology in your head.

NNModelling captures this visual design as a formal graph and compiles it
to standard PyTorch code with no runtime dependency on the editor.

Development Setup
-----------------

NNModelling is a pnpm monorepo with three packages.

Prerequisites:

* **Node.js** 18+ and **pnpm** 10+
* **Python** 3.10+ with **uv** (for running Python scripts)
* **Valkey 8** (for the local training backend)
* A modern browser (Chrome/Firefox)

Clone and install:

.. code-block:: bash

   git clone <repo-url>
   cd NNModelling
   pnpm install

This installs dependencies for both ``front-end/`` and ``mcp-server/``.

Start the editor locally
~~~~~~~~~~~~~~~~~~~~~~~~

The editor is served locally by the **companion** (the FastAPI training
backend), which also exposes the project workspace APIs on the same origin.
First build the editor once and start Valkey, then run the single start
command:

.. code-block:: bash

   pnpm --dir front-end build
   just --justfile converted/backend/justfile valkey
   PYTHONPATH=converted/src uv run --project converted python -m backend.cli

Open ``http://127.0.0.1:8000``. See :doc:`project_workspace` for the project
layout and the local/remote training connection model.

Visual Editor
-------------

Alternatively, run the Vite development server:

.. code-block:: bash

   cd front-end
   pnpm run dev

Open the URL printed by Vite (typically ``http://localhost:5173``). Vite
proxies ``/api`` to the companion at ``http://127.0.0.1:8000``.

The Canvas
~~~~~~~~~~

The editor shows a blank canvas with a **sidebar** on the right. The canvas uses
`Svelte Flow <https://www.svelteflow.dev/>`_ for interactive node editing.

Adding Nodes
~~~~~~~~~~~~

1. The canvas starts with an **Input** node (green circle). Every network needs
   exactly one Input node — it defines where data enters the graph.
2. Open the sidebar and click **Add Node** to see the list of available
   stereotypes: Linear, Conv2d, ReLU, Dropout, and many more.
3. Select a stereotype to add it to the canvas. Drag it to position it.

Connecting Nodes
~~~~~~~~~~~~~~~~~~

Each node has connection handles:

* **Top handle** — input (receives data from a previous node)
* **Bottom handle** — output (sends data to the next node)

To connect two nodes:

1. Click and drag from a node's **bottom handle** (source) to another node's
   **top handle** (target).
2. An edge appears showing the connection.

**Rules:**

* Each target handle accepts only one connection (no fan-in without an
  explicit Join node)
* Source handles allow unlimited outgoing connections (forks are implicit)
* You cannot create cycles or connect a node to itself

Join Nodes
~~~~~~~~~~~~

Standard modules accept only one input. When you need to merge multiple
branches, use a **Join node** from the sidebar (Addition, Concat, Einsum,
MatMul, ScaledDotProduct, MaskedScaledDotProduct).

Join nodes have multiple input handles (``in-0``, ``in-1``, ...) and one
output handle.

Subflow Nodes
~~~~~~~~~~~~~~~

A **Subflow** is a container that holds a sub-graph of nodes. Use subflows to:

* Organize large diagrams into logical blocks (e.g. an "Encoder" subflow)
* Apply behavioral stereotypes like **Repeat** (N sequential copies) or
  **HorizontalRepeat** (N parallel copies via vmap)

To create a subflow:

1. Click the subflow button in the toolbar
2. Drag nodes into the subflow container to add them
3. Double-click the subflow to expand/collapse its contents

Configuring Parameters
~~~~~~~~~~~~~~~~~~~~~~

Select any node to edit its parameters in the sidebar:

* **Linear**: set ``in_features`` and ``out_features``
* **Conv2d**: set ``in_channels``, ``out_channels``, ``kernel_size``
* **Repeat subflow**: set ``iterations`` to control the number of copies
* Node appearance: change color, width, height

Parameters are serialized with the diagram and used during code generation.
The sidebar form is vertically scrollable: scroll inside it to reach lower
parameters and the type-check diagnostics for the selected node.

Type diagnostics distinguish primary errors from downstream consequences. A
shape mismatch is reported on the node where it originates; nodes whose input
depends on that failure are marked as blocked rather than producing duplicate
errors.

Save and Load
-------------

When the editor runs through the companion (local start or the Vite dev
server), diagram persistence is **project-oriented**: the project chooser
creates or opens a project, and **Save** writes the current diagram to the
active project's ``model/graph.json`` through the companion API. Opening a
project or restoring the last active project loads its diagram automatically.

Save a Diagram
~~~~~~~~~~~~~~~~

* **Save**: persists the current diagram to the active project via the
  companion. A browser download remains available only as an explicit export
  fallback, not as the project save operation.
* **Load**: opens a file picker to import a previously saved diagram.

Diagrams are plain JSON — they can be version-controlled with Git, shared,
and edited programmatically.

Example Diagrams
~~~~~~~~~~~~~~~~~~

The ``examples/`` directory contains pre-built diagrams you can load:

.. code-block:: text

   examples/diagrams/
   ├── mninst.json                          # Simple MNIST MLP
   ├── mnist_skips.json                     # MNIST with skip connections
   ├── autoencoder_mnist.json               # Convolutional autoencoder
   ├── auto_encoder_submodels.json          # Autoencoder with subflows
   ├── single_head_attention.json           # Attention from primitives
   ├── multihead_attention.json             # 4-head via Concat join
   ├── horizontal_multihead_attention.json  # 4-head via HorizontalRepeat
   ├── skip_connections_with_repetition.json# Residual + Repeat subflow
   └── transformer_classifier.json          # Full transformer

Conversion Pipeline
-------------------

The core workflow is: **Visual Diagram → NNTree → Python Code → Training**.

+------------------+------------------+------------------------------------+
| Stage            | Tool             | Description                        |
+==================+==================+====================================+
| Diagram          | Visual editor    | Design the network visually        |
+------------------+------------------+------------------------------------+
| NNTree           | nnTree.ts        | Compiles to a formal tree structure|
+------------------+------------------+------------------------------------+
| Hydra configs    | convert.py       | Generates YAML config directory    |
+------------------+------------------+------------------------------------+
| Training         | main.py          | Train the model with Lightning     |
+------------------+------------------+------------------------------------+
| Inference        | infer.py         | Run predictions on new data        |
+------------------+------------------+------------------------------------+

Step 1: Export NNTree JSON
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

In the editor toolbar, click **Convert**. This compiles the diagram to an
NNTree JSON representation and downloads it.

The NNTree is an intermediate representation that captures the graph topology
as a tree structure with sequential chains, joins, and subflow boundaries.

Step 2: Generate Hydra Configs
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. code-block:: bash

   cd converted
   uv run python src/convert.py <nn_tree.json> <output_dir>

This reads the NNTree JSON and generates a directory of Hydra-compatible
YAML config files:

.. code-block:: text

   <output_dir>/
   ├── config.yaml          # Root config (imports all sub-configs)
   ├── net/
   │   └── net.yaml         # Network architecture (target: net.Net)
   ├── optimizer/
   │   └── adam.yaml        # Optimizer configuration
   ├── trainer/
   │   └── trainer.yaml     # Lightning trainer settings
   ├── dataset/
   │   └── dataset.yaml     # Dataset configuration
   └── wandb/
       └── wandb.yaml       # Weights & Biases logging

Additional CLI options:

.. code-block:: bash

   # Override dataset and number of classes
   uv run python src/convert.py diagram.json ./configs --dataset mnist --num-classes 10

   # Configure early stopping
   uv run python src/convert.py diagram.json ./configs --early-stop-patience 10

Step 3: Train the Model
~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. code-block:: bash

   uv run python src/main.py --config-dir <output_dir>

This uses Hydra to load the config and train the model via PyTorch Lightning.
Key features:

* **Automatic device detection** (GPU if available, fallback to CPU)
* **Weights & Biases logging** (disable with ``wandb.mode=disabled``)
* **Early stopping** based on validation loss
* **Checkpoint saving** for best model weights

Override Hydra configs from the command line:

.. code-block:: bash

   uv run python src/main.py --config-dir ./configs \
       trainer.max_epochs=10 \
       optimizer.lr=0.001

Step 4: Run Inference
~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. code-block:: bash

   uv run python src/infer.py \
       --config-dir <output_dir> \
       --weights <checkpoint.ckpt> \
       --output predictions.json

For visual tasks (autoencoders, image classification):

.. code-block:: bash

   uv run python src/infer.py \
       --config-dir ./configs \
       --weights ./checkpoints/best.ckpt \
       --output predictions.json \
       --image-dir ./inference_images

This saves per-sample image strips and a montage for inspection.

Testing
-------

Front-end Unit Tests
~~~~~~~~~~~~~~~~~~~~~~~~~

.. code-block:: bash

   cd front-end

   # Run all unit tests
   pnpm run test

   # Run with watch mode
   pnpm run test:watch

Integration Tests (5 tiers)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Integration tests exercise the full pipeline from diagram compilation through
training and inference:

.. code-block:: bash

   # Test a single diagram through all tiers
   NNM_DIAGRAM=mninst pnpm run test:example

   # Run all tiers
   pnpm run test:integration:all

   # Run specific tier
   pnpm run test:integration:convert

.. list-table::
   :header-rows: 1

   * - Tier
     - Command
     - What It Tests
   * - 0
     - ``test:integration:smoke``
     - NNTree compilation from JSON
   * - 1
     - ``test:integration:convert``
     - convert.py YAML generation
   * - 2
     - ``test:integration:forward``
     - Net.forward() pass
   * - 3
     - ``test:integration:train``
     - Training smoke (1 epoch)
   * - 4
     - ``test:integration:infer``
     - Inference output validation

Python Tests
~~~~~~~~~~~~~~

.. code-block:: bash

   cd converted
   uv run pytest

Or run specific test files:

.. code-block:: bash

   uv run pytest src/tests/test_ops.py
   uv run pytest src/tests/test_convert.py

Fuzz Testing
~~~~~~~~~~~~~

Fuzz tests use `fast-check <https://github.com/nicoespeon/fast-check>`_ to
validate invariants through random input generation. Three fuzzers are
implemented — they run alongside the existing unit tests:

.. code-block:: bash

   cd front-end

   # Run all tests (unit + fuzz)
   pnpm run test

   # Run fuzz tests only
   npx vitest run fuzz/

   # Run with seed for failure reproduction
   npx vitest run fuzz/ --seed=<seed>

.. list-table::
   :header-rows: 1

   * - Fuzzer
     - File
     - Invariant
     - Runs
   * - #1 — Graph Compilability
     - ``fuzz/compilability.test.ts``
     - Every graph with exactly 1 Input compiles to a valid NNTree; 0 or 2+ Inputs throw
     - 500
   * - #3 — Serialization Idempotence
     - ``fuzz/serialization.test.ts``
     - ``export → import → export`` produces identical JSON
     - 200
   * - #4 — Operation Commutativity
     - ``fuzz/operations.test.ts``
     - After every operation the graph is consistent; undo/redo returns to exact state; 50-entry stack limit
     - 200

Fuzzer #2 (Forward Pass) is not yet implemented — it would generate random
NNTree JSON with compatible shapes and verify the Python pipeline
(``convert.py`` → ``Net.forward()``).

MCP Server
----------

NNModelling includes an MCP (Model Context Protocol) server that lets LLM
agents interact with the visual editor through WebSocket RPC.

Start the server:

.. code-block:: bash

   cd mcp-server
   pnpm run build
   pnpm run start

Or run directly with tsx for development:

.. code-block:: bash

   npx tsx mcp-server/src/index.ts

The server provides ~38 tools for graph manipulation, parameter management,
validation, conversion, and more. It supports **multi-tab browsing** —
multiple browser tabs can connect simultaneously and you can switch between
them using ``list_browser_tabs`` and ``select_browser_tab``.

Pipeline Workflow Summary
-------------------------

Here is the complete workflow from design to trained model:

1. **Design** — Drag nodes onto the canvas, connect them, configure parameters
2. **Save** — Save the diagram as JSON (or load an existing example)
3. **Convert** — Click Convert to generate the NNTree JSON
4. **Generate Configs** — Run ``convert.py`` to produce Hydra YAML configs
5. **Train** — Run ``main.py`` to train the model
6. **Evaluate** — Run ``infer.py`` to run predictions and inspect results
7. **Iterate** — Adjust the diagram and repeat

This workflow means your neural network design is **version-controllable**
(the diagram JSON), **reviewable** (visual graph), and **reproducible**
(the generated code uses standard PyTorch + Hydra with no proprietary runtime).
