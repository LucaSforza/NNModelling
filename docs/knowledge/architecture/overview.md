---
kind: knowledge
status: current
updated: 2026-08-12
---

# System architecture

NNModelling is a visual DSL that turns a browser diagram into executable
PyTorch/Lightning configuration. This document is the internal architectural
map; public user documentation lives under `docs2/`.

## Components

| Area | Responsibility | State authority |
| --- | --- | --- |
| `front-end/` | Svelte editor, graph mutations, type inference, NNTree compilation | Browser `DiagramCore` |
| `Stereotypes/` | Declarative node presentation, parameters, tensor contracts and operations | JSON definitions |
| `mcp-server/` | MCP tools, browser WebSocket routing, Python subprocess boundary | No diagram state |
| `converted/` | NNTree conversion, Hydra configuration, runtime, training, inference and remote backend | Python configs and backend stores |
| `examples/` | Editable diagrams, compiled fixtures and integration metadata | Format-specific fixtures |

## Primary data flow

```text
Stereotypes JSON
    -> DiagramCore in the browser
    -> NNTree compilation
    -> convert.py
    -> Hydra configuration
    -> PyTorch/Lightning runtime
```

The browser is the only source of truth for a live diagram. The MCP server
routes request/response RPC to the selected browser tab and must not mirror the
graph. See [Browser-backed MCP](browser-mcp.md).

`DiagramCore` also owns the diagram's presentation direction (`vertical` or
`horizontal`). Automatic layout validates and computes the complete recursive
geometry off-state, then applies node positions, expanded subflow dimensions
and direction as one snapshot-based mutation. Editable diagram JSON persists
the optional `layoutDirection` field; missing or unknown values default to
vertical. This presentation metadata is not part of NNTree output.

Remote training is an optional second boundary:

```text
compiled NNTree + training request
    -> FastAPI
    -> Valkey queue
    -> Local or Slurm executor
    -> training artifacts and inference wheel
```

See [Remote training](remote-training.md), the
[pairing contract](../contracts/pairing.md), and the
[model-package contract](../contracts/model-package.md).

## Durable invariants

- Top-level graphs have exactly one `Input`; subflows have separate boundary
  rules documented in `Stereotypes/AGENTS.md`.
- Join inputs retain target-handle order, which is semantically significant for
  non-commutative operations.
- Every edge connects endpoints in the same immediate containment scope. A
  subflow is an atomic node in its parent's scope, and its children cannot
  connect directly outside it.
- Hidden children of collapsed subflows still compile.
- Automatic layout retains hidden children and computes every containment
  scope bottom-up. Svelte Flow handle internals and viewport fitting are
  browser-only synchronization performed after the reactive DOM update.
- Tensor behavior is selected by stereotype data. The engine implements
  generic semantics without branching on stereotype names.
- Source Svelte Flow diagrams and compiled NNTree fixtures are different
  formats and are never interchangeable.

Package-local implementation rules live in the nearest `AGENTS.md`. Historical
designs and implementation reports live under `docs/archive/` and are not
authoritative.
