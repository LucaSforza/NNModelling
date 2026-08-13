---
id: recursive-compound-layout
kind: decision
status: accepted
updated: 2026-08-13
---

# Use recursive Dagre layout for compound diagrams

## Context

NNModelling diagrams are directed acyclic graphs whose visual nodes can be
nested recursively inside subflow nodes. Child positions are relative to their
parent, collapsed children remain semantically active, and subflows connect to
their surrounding scope through the subflow's own `in` and `out` handles.

Svelte Flow deliberately does not include a layout engine. Its
[layout overview](https://svelteflow.dev/learn/layouting/overview) presents
Dagre as the simpler directed-graph option and ELK as the more configurable
compound-graph and edge-routing option. Dagre cannot correctly lay out a
subflow when a child connects directly outside that subflow. NNModelling does
not permit such edges: every edge belongs to exactly one containment scope.

## Decision

- Use `@dagrejs/dagre` independently within each containment scope.
- Compute layouts bottom-up. Layout nested children first, derive the expanded
  size of their parent subflow, and then treat that subflow as an atomic node in
  its parent's Dagre graph.
- Support top-to-bottom and left-to-right directions through one shared layout
  function.
- Persist the chosen direction as optional diagram presentation metadata;
  diagrams without it default to vertical.
- Keep edge routing unchanged in the first implementation.
- Reject connections, reconnections, reparenting and imports that would create
  an edge across containment scopes. External flow must connect to the
  subflow's `in` or `out` handle, never directly to one of its children.

## Consequences

- Recursive and collapsed subflows can be laid out without relying on Dagre's
  unsupported compound-edge case.
- Subflow dimensions are derived from their arranged contents and may grow or
  shrink. A collapsed subflow retains the computed expanded dimensions for the
  next expansion while remaining compact in its parent's visible layout.
- The layout engine stays synchronous, deterministic and small enough to unit
  test outside Svelte.
- Horizontal layout also requires dynamic node handle positions. Svelte Flow's
  node internals must be refreshed after the direction changes, as required by
  [`useUpdateNodeInternals`](https://svelteflow.dev/api-reference/hooks/use-update-node-internals).
- If a future requirement includes automatic orthogonal edge routing or legal
  edges crossing compound boundaries, the pure layout adapter can be replaced
  by ELK without changing graph ownership or the UI command contract.

## Affected contracts

- [System architecture](../architecture/overview.md)
- [NNTree contract](../contracts/nntree.md)
- [Automatic compound layout plan](../../plans/active/automatic-layout/plan.md)
