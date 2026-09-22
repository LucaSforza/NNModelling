# NNModelling

[![CI](https://github.com/LucaSforza/NNModelling/actions/workflows/ci.yml/badge.svg)](https://github.com/LucaSforza/NNModelling/actions/workflows/ci.yml)
[![GitHub Pages](https://img.shields.io/badge/demo-GitHub%20Pages-2ea44f?logo=github)](https://lucasforza.github.io/NNModelling/)

Design neural networks as visual graphs, inspect tensor shapes and dtypes while
editing, and train through an isolated backend. Export a Python wheel that runs
the trained prediction model without this checkout.

```text
Project directory → editor + Lua tensor inference → authenticated uploads
                  → container training worker → portable prediction wheel
```

## Run the editor

```bash
pnpm install --frozen-lockfile
pnpm --dir front-end dev --host 127.0.0.1 --port 5174
```

Open the URL printed by Vite. Choose **New project** to create a writable project
directory, or **Open project** to select one containing `model.json`. Graph
changes save automatically. The web editor needs writable directory access
through the browser's File System Access API.

You can also [open the web distribution](https://lucasforza.github.io/NNModelling/)
or build the [Linux desktop application](docs2/source/desktop.rst). The desktop
host uses the same editor and project format. Neither distribution includes a
training backend.

To try an existing model, copy an entire directory from
`examples/diagrams/package/models/`, including its custom packages and datasets,
then open the copy. Start with the [VAE or ResNet guide](docs2/source/examples.rst).
Prepare their data files before training; cloning the example does not download
MNIST.

## Train and use a model

The Training sidebar pairs with an operator-managed backend. Select a project
dataset, match graph Input bindings to its named tensor slots, and configure the
objective and job settings. A successful job provides a downloadable wheel with
trained weights and the public `Model` prediction API.

- [Training workflow](docs2/source/training_user_guide.rst)
- [Backend installation, pairing and operations](docs2/source/training_admin_guide.rst)
- [Using an exported model in Python](docs2/source/python_api.rst)

The supported backend accepts package graphs and project datasets. Historical
NNTree fixtures are not editable projects or inputs to this workflow.

## Documentation

Build the public Sphinx guides and generated TypeScript reference:

```bash
pnpm run docs
```

Outputs are `docs2/build/html/` and `docs2/build/typedoc/`.
[Documentation build instructions](docs2/README.md) cover prerequisites,
previewing both sites and strict checks.

- [Getting started](docs2/source/getting_started.rst)
- [Projects and graph editing](docs2/source/user_guide.rst)
- [Project datasets](docs2/source/datasets.rst)
- [Custom stereotypes](docs2/source/stereotypes.rst)
- [Tensor type system](docs2/source/type_system.rst)
- [Architecture](docs2/source/architecture.rst)
- [Troubleshooting](docs2/source/troubleshooting.rst)

Internal architecture and contributor contracts are indexed in
[docs/README.md](docs/README.md). Repository instructions live in
[AGENTS.md](AGENTS.md), with package-specific guidance below it.

## Development checks

Run the checks for the package you change:

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir mcp-server test
cd converted && uv run pytest src/tests/ -m fast -q
```

Frontend and MCP builds use `pnpm --dir <package> build`. Slow backend and
integration tiers have separate prerequisites; consult the relevant package's
`AGENTS.md` before running them. Browser-backed MCP needs a running editor and
selected tab; see the [MCP architecture](docs/knowledge/architecture/browser-mcp.md).
