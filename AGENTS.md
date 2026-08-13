# NNModelling agent guidance

This file contains repository-wide rules. More specific instructions live in:

- `front-end/AGENTS.md` — Svelte editor, diagram core, type engine, browser RPC.
- `converted/AGENTS.md` — Python conversion, runtime, training, inference, backend.
- `mcp-server/AGENTS.md` — MCP thin proxy and browser WebSocket client.
- `Stereotypes/AGENTS.md` — stereotype schemas and tensor type contracts.

Codex combines this file with the nearest package-local file. Current internal
architecture and contracts are indexed by `docs/README.md`; historical guidance
is preserved under `docs/archive/`.

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
- Before the final handoff, push, PR-readiness transition, release, or deployment,
  load `.agents/skills/verify-task/SKILL.md` and perform proportional final QA
  through the real user-facing interface. This is required for every completed
  task and is not a request for automatic line-by-line code review.

OpenCode-specific model routing, agent roster, and execution loops are defined
in `docs/orchestrators/opencode.md`. When acting as an OpenCode architect, use
the OpenAI or DeepSeek implementer explicitly requested by the user; do not
select one on the user's behalf. These routing rules do not select Codex models.

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
- `docs2/` contains public Sphinx documentation. `docs/` contains tool-neutral
  agent plans and internal project knowledge; see `docs/README.md`.

The principal flow is:

```text
Stereotypes JSON -> browser DiagramCore -> NNTree JSON -> convert.py
                 -> Hydra configs -> PyTorch/Lightning runtime
```

## Browser-backed work

Load the applicable repository skill before opening or manipulating the editor,
inspecting tensor types, taking screenshots, converting, training, running
inference, or diagnosing browser connectivity:

- `.agents/skills/nnmodelling-mcp/SKILL.md` for all live NNModelling editor,
  diagram, type, conversion, training, inference and browser-connectivity work.
  It selects the Codex in-app Browser when available and preserves external
  Chromium/CDP as the OpenCode and unsupported-host fallback.
- `.agents/skills/chrome-direct/SKILL.md` for direct Chrome/Chromium CDP work,
  especially when the user asks to use Chrome directly or not to use MCP.

Reuse `.agents/skills/nnmodelling-mcp/scripts/nnm-stack.sh` for the shared
frontend/MCP lifecycle and external-browser fallback; do not reconstruct those
commands manually.

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
