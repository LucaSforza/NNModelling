# Edge Sync Bug: MCP-Created Edges Not Visible in Browser

## Description

When an edge is created via the MCP `connect_nodes` tool, the edge is correctly added to the server-side `DiagramCore` state, but it is **not reflected in the browser UI**.

The user can verify that nodes created via MCP tools are synced correctly, but edges are missing.

## Reproduction

1. Use `create_node` to create an Input and a Linear node → visible in browser ✓
2. Use `connect_nodes` to connect Input → Linear → edge appears in `get_graph` on server side ✓
3. Look at the browser canvas → edge is **not visible** ✗

## Analysis

The WebSocket delta broadcast mechanism seems to work for node mutations (add, delete, move) but fails for edge mutations. The browser's `DiagramSyncClient` either:

- Does not receive the delta for edge mutations, or
- Receives it but fails to apply it to the `$state.raw` edges array, or
- The delta format for edges differs from what the client expects

## Impact

- MCP-driven graph construction is broken for any workflow involving connections
- The model cannot reliably build diagrams with edges
- The user has to manually recreate all connections in the browser UI, defeating the purpose of headless MCP manipulation
