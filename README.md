# NNModelling

[![CI](https://github.com/LucaSforza/NNModelling/actions/workflows/ci.yml/badge.svg)](https://github.com/LucaSforza/NNModelling/actions/workflows/ci.yml)
[![GitHub Pages](https://img.shields.io/badge/demo-GitHub%20Pages-2ea44f?logo=github)](https://lucasforza.github.io/NNModelling/)

A visual editor and DSL for designing neural networks. Create diagrams in the browser, compile them to NNTree, and generate PyTorch/Lightning training pipelines.

## Try the editor

**[Open NNModelling in your browser](https://lucasforza.github.io/NNModelling/)**

The GitHub Pages demo contains the visual editor and runs entirely in the browser. Remote training, conversion, and MCP/browser integration require a local or separately deployed backend.

Linux users can also run the same editor as an Electron Flatpak. The Flatpak
contains the desktop shell and shared frontend; FastAPI, Valkey, Podman/Docker
and worker images remain in the separately managed backend. See the
[Linux desktop documentation](docs2/source/desktop.rst) for source builds,
installation and the exact `app://nnmodelling` backend origin.

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
