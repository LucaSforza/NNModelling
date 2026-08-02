# NNModelling

[![CI](https://github.com/LucaSforza/NNModelling/actions/workflows/ci.yml/badge.svg)](https://github.com/LucaSforza/NNModelling/actions/workflows/ci.yml)
[![Install](https://img.shields.io/badge/install-GitHub%20Pages-2ea44f?logo=github)](https://lucasforza.github.io/NNModelling/)

A visual editor and DSL for designing neural networks. Create diagrams in the browser, compile them to NNTree, and generate PyTorch/Lightning training pipelines.

## Install and start locally

The editor is served locally by the companion together with a local training
backend — it is no longer hosted on GitHub Pages (the Pages site now publishes
only installation instructions and the installer script). The installer checks
for, but does not install, these prerequisites: Git, Python 3.12+ with
[`uv`](https://docs.astral.sh/uv/), Node.js 18+ with pnpm 10+, and Valkey 8
(either a running instance or the `valkey-server` binary).

```bash
# One command — fetches, builds, and starts:
curl -fsSL https://lucasforza.github.io/NNModelling/install.sh | bash
```

The installer clones the repository (or updates an existing checkout) into
`$HOME/.local/share/nnmodelling`, installs the pnpm dependencies, builds the
editor, reuses a healthy Valkey instance or starts a repository-local
`valkey-server` process, and then starts the companion at
<http://127.0.0.1:8000>. It fails with instructions when a prerequisite is
missing or the destination is not an NNModelling checkout, never prints
secrets, and stops only the Valkey process it started when the companion
exits. Configure with `NNM_DEST_DIR`, `NNM_REMOTE_REPO`, `NNM_BRANCH`,
`NNM_VALKEY_URL`/`NNM_VALKEY_PORT`, or `NNM_BACKEND_HOST`/`NNM_BACKEND_PORT` —
in a pipeline the overrides go on the `bash` side, not on `curl`:

```bash
curl -fsSL https://lucasforza.github.io/NNModelling/install.sh | NNM_DEST_DIR=~/nnmodelling bash
```

Open <http://127.0.0.1:8000>. The Training Sidebar keeps its URL/pairing
workflow, so you may connect it either to this localhost backend or to an
independently managed remote backend URL. The companion never proxies or
routes remote jobs. Developers can skip the installer and run the same steps
by hand instead (see the next section).

```
Stereotypes/ (JSON) → Svelte Flow Editor → NNTree (JSON) → convert.py → Hydra YAML → main.py → Training
                                                                                       → infer.py  → Inference
```

## Quick Start

### Frontend (Editor)

```bash
# From the repository root
pnpm install
pnpm --dir front-end dev       # Development server with hot reload
pnpm --dir front-end build     # Production build
pnpm --dir front-end preview   # Preview production build
```

### Backend (Training)

```bash
cd converted
uv sync
uv run python src/convert.py <nn_tree_json> <output_dir>
uv run python src/main.py --config-dir <dir>

# Local companion (serves the editor + training backend on localhost)
PYTHONPATH=src uv run python -m backend.cli
```

### MCP Server

```bash
cd mcp-server
pnpm run build      # Compile TypeScript
pnpm run start      # Start server (node dist/index.js)
```

## Key Concepts

- **Nodes**: Layers (Linear, Conv2d, ReLU...), Joins (Addition, Concat, MatMul...), SubFlows (Repeat, HorizontalRepeat), Loss (CrossEntropyLoss...)
- **Edges**: Data flow between nodes. Forks implicit, joins explicit.
- **NNTree**: Intermediate representation — compiled DAG preserving sequential chains, join ordering, and recursive subflows.
- **SubFlows**: Containers with internal graph topology. Repeat (sequential N times with independent weights) and HorizontalRepeat (parallel N copies via vmap).
- **Join ordering**: Non-commutative joins (MatMul, ScaledDotProduct) receive inputs ordered by edge targetHandle, not BFS arrival.
- **Stereotypes**: JSON files defining node category, Python class mapping, view defaults, and configurable parameters.
- **MCP Server**: Thin proxy that enables LLM agents to manipulate the diagram via WebSocket RPC to the browser.

## Building from Source

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm --dir front-end build          # Visual editor
pnpm --dir mcp-server build         # MCP server

# Build documentation
pnpm docs
```

## Documentation

For the local documentation site:

```bash
cd docs2 && uv run make html
```

The Sphinx docs cover:

- **User Guide** — how to use the visual editor
- **Project Workspace** — project layout, local environments, training runs
- **Training guides** — pairing, localhost vs remote backends, administration
- **Architecture** — system design, data flow, components
- **Stereotypes Reference** — JSON format, categories, all parameters
- **Python API Reference** — convert.py, main.py, infer.py, Net, ops
- **TypeScript API Reference** — DiagramCore, StereotypeCore, BrowserRPCHandler
- **Examples** — walkthrough of all 10 example diagrams

See also `CLAUDE.md` / `AGENTS.md` for the AI agent project guide.

## Testing

```bash
# Frontend unit tests
pnpm --dir front-end test

# Integration tests (tiered: compile → convert → forward → train → infer)
pnpm --dir front-end test:integration

# Python tests
cd converted && uv run pytest src/tests/ -v
```
