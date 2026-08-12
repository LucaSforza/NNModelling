# Detailed Report of MCP Core Issues (Synchronization and Node Creation Failures)

This report details anomalies observed when interacting with the MCP API and the Svelte frontend, based on analysis of the source code for `mcp-server/src/tools/graph.ts` (proxy) and `front-end/src/core/DiagramCore.ts` (state logic).

## 1. Issue: Missing Node/Edge Visualization (Image 1)

**Symptom:** Created nodes appear far outside the user's viewport (Requires manual `fit_view`), and edges created via RPC are not rendered in the Svelte Flow canvas, even though they exist in the graph state (`get_graph` returns them).

**Analysis in MCP Server Code (`graph.ts`):**
The server is only a proxy. It forwards the `create_node` or `connect_nodes` action and awaits the result. The event emission (`node_created`, `edge_created`) happens correctly in the `addEdge` (lines 475-481) and `addModule` (lines 149-154) functions within `DiagramCore.ts`.

**Frontend Diagnosis (Svelte):**
The issue is related to reactivity/rendering:
*   **Edges:** The `edge_created` event is failing to trigger a re-render in Svelte Flow to draw the edge.
*   **Positioning:** The `graph_changed` event (emitted after every mutation) is not correctly triggering a call to `center_view` or `fit_view` in the Svelte handler, or the view adaptation logic is ignoring the state change.

**Required Frontend Fix:** Verify that Svelte handlers for `edge_created` and `graph_changed` events (emitted from `DiagramCore`) correctly invoke the visualization APIs (`fit_view`/`center_view`) to realign the camera.

## 2. Issue: Node Parameters Not Saved/Displayed Correctly (Image 2)

**Symptom:** Explicit parameters passed via the `create_node` RPC for nodes like `Linear` are either not saved correctly in the node's state (`node.data.params`) or are being ignored/overwritten. This leads to incorrect default values being displayed (e.g., `Undefined` for features) even after explicitly setting them.

**Analysis in Frontend Code (`DiagramCore.ts`, lines 137-145):**
The logic in `addModule` for creating 'custom' type nodes is flawed:
```typescript
141:         params: customConfig?.params ? JSON.parse(JSON.stringify(config.params)) : {},
```
If `customConfig?.params` is present, it **completely overwrites the `params` object**, ignoring any default parameters defined in the stereotype that were not explicitly included in the user input. While I provided `in_features` and `out_features`, this mechanism failed to correctly handle the data or merge defaults, resulting in `Undefined` values when queried later.

**Suggested Fix (Frontend):**
The node creation logic must deeply merge the user-supplied parameters (`customConfig?.params`) with the default parameters defined in the stereotype, instead of completely substituting the `params` object.

**Note:** I temporarily worked around this issue by explicitly forcing the parameters using `set_parameter` calls after creation, indicating that the `set_parameter` logic is more robust than the `create_node` logic for parameter persistence.

## 3. Detail on Linear Node Parameters

**Stereotype Reference (`Stereotypes/Modules/Linear.json`):**
Expected parameters are: `in_features` (top), `out_features` (bottom), `bias` (default True), `device`, `dtype`.

**Action Item for MCP Server (For future debugging):**
No direct action is needed on the MCP server as it only acts as a relay. However, for future debugging, the MCP server should implement logging for both the **full input payload received** for `create_node` and the **sent payload for `set_parameter`** to trace where the value persistence failure occurs between the RPC client and `DiagramCore`.
```
