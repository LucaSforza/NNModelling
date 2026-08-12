# NNModelling agent guidance

This file contains repository-wide rules. More specific instructions live in:

- `front-end/AGENTS.md` — Svelte editor, diagram core, type engine, browser RPC.
- `converted/AGENTS.md` — Python conversion, runtime, training, inference, backend.
- `mcp-server/AGENTS.md` — MCP thin proxy and browser WebSocket client.
- `Stereotypes/AGENTS.md` — stereotype schemas and tensor type contracts.

Codex combines this file with the nearest package-local file. Detailed project
history and the former monolithic instructions are preserved in
`docs/agent-reference.md`.

## Repository rules

- Use the `fff` MCP tools for all file searches. Use `grep` for file contents,
  `find_files` for filenames, and `multi_grep` for multiple literal patterns.
- Preserve unrelated user changes in a dirty worktree.
- Prefer `pnpm` for JavaScript/TypeScript workspace commands and `uv` for Python.
- Keep changes at the narrowest responsible package boundary.
- Run the smallest relevant verification first, then the package gate described
  in its local `AGENTS.md`.
- Do not copy historical test counts into status reports; rerun the relevant
  command and report its current result.

OpenCode-specific model routing, agent roster, and execution loops are defined
in `docs/opencode.md`. When acting as an OpenCode architect, use the OpenAI or
DeepSeek implementer explicitly requested by the user; do not select one on the
user's behalf. These routing rules do not select Codex models.

## Project overview

NNModelling is a visual DSL for designing neural networks and converting diagrams
to PyTorch/Lightning code. It is a pnpm workspace with three main packages:

1. `front-end/` — Svelte 5 + Svelte Flow visual editor and TypeScript compiler.
2. `converted/` — Python code-generation target, runtime, training and backend.
3. `mcp-server/` — MCP server that proxies browser diagram state over WebSocket RPC.

Shared inputs and fixtures:

- `Stereotypes/` contains JSON definitions for modules, joins and subflows.
- `examples/diagrams/` contains editable Svelte Flow diagrams.
- `examples/nntrees/` contains compiled NNTree fixtures.
- `examples/manifest.json` drives cross-language integration tests.
- `docs2/` contains Sphinx documentation; `docs/` contains designs and reports.

The principal flow is:

```text
Stereotypes JSON -> browser DiagramCore -> NNTree JSON -> convert.py
                 -> Hydra configs -> PyTorch/Lightning runtime
```

## Browser-backed work

Load the applicable repository skill before opening or manipulating the editor,
inspecting tensor types, taking screenshots, converting, training, running
inference, or diagnosing browser connectivity:

- `.agents/skills/chrome-direct/SKILL.md` for direct Chrome/Chromium CDP work,
  especially when the user asks to use Chrome directly or not to use MCP.
- `.agents/skills/nnmodelling-mcp/SKILL.md` only when the user explicitly asks
  for MCP or the browser-backed MCP server.

Reuse `.agents/skills/nnmodelling-mcp/scripts/nnm-stack.sh`; do not reconstruct
the frontend/browser/MCP startup lifecycle manually.

## Cross-package invariants

- The browser's `DiagramCore` is the only authority for live diagram state.
  The MCP server must remain a thin proxy and must not introduce a second graph.
- Stereotype behavior and tensor contracts are data-driven. Avoid hardcoded
  module names, formula bodies, or join/subflow rules in the type engine.
- A top-level model requires exactly one `Input`. An internal subflow may use an
  `Input` only as its declared boundary entry; `Fork` is the canonical internal
  pass-through and cannot replace the required top-level `Input`.
- Join parent ordering is determined by `targetHandle` (`in-0`, `in-1`, ...),
  not traversal order. This is required for non-commutative joins.
- Collapsed or hidden subflow children still compile.
- Editable source diagrams and compiled NNTree artifacts are distinct; do not
  treat `examples/nntrees/` as editable browser diagrams.

## Common commands

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir mcp-server test
cd converted && uv run pytest src/tests/ -m fast -q
pnpm run docs
```

Integration tests are tiered under `front-end/`; see `front-end/AGENTS.md` before
running slow training or inference tiers.
