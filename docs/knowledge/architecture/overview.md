---
kind: knowledge
status: current
updated: 2026-08-29
---

# System architecture

NNModelling is a browser-owned visual DSL. The current editor builds package
graphs and infers their tensor semantics locally. Public user documentation
lives under `docs2/`.

## Components

| Area | Responsibility | State authority |
| --- | --- | --- |
| `front-end/` | Svelte editor, graph mutations, package catalog, Lua type inference and browser RPC | Browser `DiagramCore` |
| `stereotype-packages/` | Independently identified definitions, Lua inference and future PyTorch entrypoints | Package manifest and resources |
| `mcp-server/` | Thin proxy to the selected browser tab | No diagram or type state |
| `converted/` | Package compiler/runtime, authenticated API, scheduler and worker controller | Valkey job state and backend stores |
| `examples/` | Package-format editable diagrams and historical compiled fixtures | Format-specific fixtures |

## Current frontend flow

```text
bundled packages + IndexedDB external records
        |
        v
composed package catalog -> Cordis services/Fibers -> isolated Lua inference
        |                                               |
        v                                               v
DiagramCore graph <------------------------------- semantic type state
        |                                               |
        +--> visible editor + Packages manager           |
        +--> browser-backed MCP <------------------------+
```

The browser is the only source of truth for a live diagram. The MCP server
routes request/response RPC and must not mirror the graph, catalog or inferred
types. See [Browser-backed MCP](browser-mcp.md).

Every frontend node persists only exact package ID and version. Definition
metadata drives topology, parameters, presentation and dtype controls;
package-owned Lua drives inference. External records retain immutable bytes and
resolved dependency keys in IndexedDB, never in project JSON. The frontend
contains no central package-ID inference switch.

## Backend boundary

The backend standard is package-native. Historical NNTree conversion artifacts
are archived and are not an input to the public backend path. The accepted
target is documented in the
[package backend decision](../decisions/package-backend-standard.md) and
implemented by the active
[package-backend-standard plan](../../plans/active/package-backend-standard/plan.md).

That target makes package graphs the only backend format and places all
`pytorch.py` execution behind a least-privilege Podman/Docker worker. Lua
remains the sole frontend semantic authority; PyTorch is never a type-
inference fallback.

See [Remote training](remote-training.md), the [pairing contract](../contracts/pairing.md),
and the [model-package contract](../contracts/model-package.md).

## Durable invariants

- `DiagramCore` owns every live graph mutation and snapshot.
- Every frontend node has exact package identity and primitive parameter data.
- Bundled packages activate during bootstrap; external package metadata is
  durable and external activation is on demand after reload.
- Type semantics come from activated package definitions and Lua rules.
- Expected semantic errors, unresolved editor state and runtime faults remain
  distinct.
- The browser owns package diagnostics and MCP forwards them without a second
  catalog or runtime state.
- Join inputs retain `targetHandle` order.
- Every edge connects endpoints in the same immediate containment scope.
- Hidden children of collapsed subflows remain part of graph semantics.
- Editable package diagrams and historical compiled NNTree fixtures are
  different formats; only package bundles may enter the backend.
- Presentation metadata, including automatic layout and editable edge routes,
  does not affect package semantics.

The current type boundary is documented in
[Frontend package type system](../contracts/package-type-system.md).
Historical designs and implementation reports under `docs/archive/` are not
authoritative.
