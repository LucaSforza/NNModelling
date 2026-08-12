Report on glimpse Limitations and Specification for New MCP Tool
Date: June 29, 2026
Author: NNModelling Designer
Subject: Need for a new MCP tool to handle complex application interaction beyond glimpse capabilities.

1. Fundamental Limitations of glimpse
The glimpse toolset is effective for visual and static inspection (screenshots, DOM inspection, accessibility audits) and simple, standard user interactions (click, type, select on standard elements). However, it presents significant limitations when attempting complex, domain-specific actions required by the Node Editor:

- Edge Creation (Connection Building): There is no direct command in glimpse_interact to simulate drag and drop between a source handle (output) and a target handle (input) of two separate nodes. This is the fundamental step required to define the topology of a neural network graph.
- Interaction with Custom Components: Actions like select on custom components (e.g., SDropdown in the Sidebar) are unreliable and frequently time out, suggesting they do not expose the standard HTML <select> API expected by the tool.
- Inability for Direct State Manipulation: It is impossible to access and modify the reactive state of the diagram (Diagram.svelte.ts) without simulating unreliable UI interactions, which is inefficient for constructing complex graphs or correcting errors.
1. Specification for New MCP Tool
The new MCP tool must be designed to work in concert with glimpse, not replace it entirely.

- glimpse will continue to be used for:
- Visual verification before/after changes (screenshot, smart_diff).
- Pointwise DOM auditing (dom_inspect).
- Accessibility checks (accessibility).
- New MCP Tool (e.g., diagram_editor_manipulator) should be used for:
- Edge Creation: A function like create_edge(source_node_id, target_node_id, source_handle_id, target_handle_id).
- Node State Manipulation: Functions to update node parameters or force node positioning.
- Complex Canvas Actions: A function like add_node_with_connections(...) that internally executes the full workflow (node creation + edge creation).
This tool would act as a "backend-driven frontend manipulator," enabling reliable construction of complex graphs and immediate testing of the conversion pipeline.
Requested Functionality for New MCP Tool:

1. create_edge(sourceId, targetId): Creates a valid connection between two nodes.
2. set_node_position(nodeId, x, y): Sets the exact position of a node.
3. set_input_shape(nodeId, shape): Configures the output shape for an input node (e.g., Input_0) to resolve undefined parameters in subsequent layers.
4. execute_conversion(export_json_flag): Executes the NNTree to Hydra config conversion pipeline, automatically resolving necessary graph connections.
