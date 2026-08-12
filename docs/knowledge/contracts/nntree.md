---
kind: knowledge
status: current
updated: 2026-08-12
---

# NNTree contract

NNTree is the compiled boundary between the visual editor and Python
configuration generation. It is not the same format as an editable Svelte Flow
diagram.

## Top-level shape

```json
{
  "root": "runtime-node-id",
  "lossNode": null,
  "nodes": {
    "runtime-node-id": {
      "id": "runtime-node-id",
      "children": [],
      "data": { "type": "module" }
    }
  }
}
```

- `root` identifies the first runtime node produced from the unique top-level
  Input path.
- `lossNode` is the separately extracted terminal training objective or `null`.
- `nodes` maps runtime IDs to `{id, children, data}` entries.
- `children` contains downstream runtime IDs.

## Node data variants

- `module`: one runtime module with name, stereotype, Python class and params.
- `sequential`: an ordered array of module data compacted into one segment.
- `join`: a multi-input operation with an explicit `inputs` array.
- `subflow`: a recursive internal graph with `entryNode` and `nodes`.

Subflow-internal nodes use the same module/join/subflow variants plus `children`.
Nested subflows are recursive and remain structurally distinct rather than
being flattened.

## Ordering and graph invariants

- Compilation rejects a top-level directed cycle and uses topological ordering
  inside subflows.
- A top-level graph must contain exactly one Input.
- Loss nodes are excluded from ordinary runtime children and stored separately.
- Join `inputs` are ordered by numbered target handles (`in-0`, `in-1`, ...).
  Legacy unnumbered handles remain stable after numbered inputs.
- Visual pass-through producers may be remapped to the runtime ID emitted after
  sequential compaction.
- Collapsed/hidden subflow nodes still participate in compilation.

## Consumers and fixtures

- Producer: `front-end/src/conversion/nnTree.ts`.
- Consumer: `converted/src/convert.py`.
- Editable sources: `examples/diagrams/`.
- Compiled fixtures: `examples/nntrees/`.
- Cross-language metadata: `examples/manifest.json`.

Any contract change requires frontend compiler tests, converter tests and the
relevant smoke/convert/forward integration tiers. Persisted compatibility must
be considered separately from TypeScript interface changes.
