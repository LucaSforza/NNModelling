# Diagnostic Report for Type Checker Failures in Frontend

**Agent Task:** Analyze the symptoms of the persistent Type Checker errors in the running frontend application (localhost:5174) and synthesize a precise description of the observed problems and the code areas implicated. **DO NOT** suggest specific fixes; describe **WHAT** is wrong and **WHERE** it occurs.

## Observed Symptoms (Runtime - Screenshot Analysis)

The user interface displays critical warnings in the "Type Check" panel for nodes that are currently active in the diagram:

1.  **Persistent Type Signature Errors:** Nodes are flagged with warnings stating: `No type signature for "<Stereotype Name>"`.
    *   **Affected Stereotypes (Visible):** "Input", "Linear", "MSELoss".
    *   **Implication:** The Type Inference Engine (`TypeEngine.ts`) is failing to retrieve or recognize the `type_signature` field from the Stereotype objects it loads, despite the JSON structure seemingly supporting it.

2.  **Node Misalignment (Secondary Symptom):** The `Input_0` node's output handle appears misaligned/incorrectly positioned relative to the connected edge. This often correlates with successful type inference where shape/size information dictates handle placement.

3.  **Previous Runtime Error (Resolved):** An `Uncaught TypeError: diagram.events.off is not a function` was observed during HMR teardown in `FlowCanvas.svelte`, indicating an incorrect pattern for unsubscribing from `graph_changed` events. (This has been addressed, but its prior existence suggests instability in core event handling logic).

## Implicated Code Areas (Build/Static Analysis)

Static analysis (`svelte-check`) revealed fundamental inconsistencies in type definitions across core frontend modules, pointing to a likely corrupted state following a recent merge:

1.  **`front-end/src/core/StereotypeCore.ts`**:
    *   **Issue:** The interface `StereotypeJson` was missing the `typeSignature?: TypeSignature;` property, leading to compilation errors downstream.
    *   **Issue:** The import path for type definitions (`./tensortypes`) was incorrect (resolved to relative path `./tensortypes` instead of `../conversion/tensortypes`).

2.  **`front-end/src/core/index.ts`**:
    *   **Issue:** This file was attempting to re-export numerous IPC/Server-related types (`EventCallback`, `WSSnapshotMessage`, etc.) which are no longer defined in `./types.ts` (as per Phase 11 cleanup documentation).

3.  **`front-end/src/conversion/typeEngine.ts`**:
    *   **Issue:** Compilation failed because it treated `stereotype` as lacking the `typeSignature` property, directly resulting from the issue in `StereotypeCore.ts`.

4.  **Test Suites (`__tests__/**/*.ts`)**:
    *   **Issue:** Test suites are failing with errors like `Cannot find name 'expect'` and `Cannot find name 'describe'`, indicating that the environment required for Vitest/Jest (likely `@types/jest`) is not correctly configured or recognized during the check.

5.  **`front-end/src/nodes/SubflowNode.svelte`**:
    *   **Issue:** The node attempts to call a non-existent method `data.onResizeEnd(...)` on its node data during the `OnResizeEnd` event from `NodeResizer`.

## Conclusion for Next Agent

The core problem appears to be a **type definition mismatch** stemming from the merge, which has broken the static analysis pipeline. Specifically, the definition of what constitutes a `Stereotype` (in `StereotypeCore.ts`) is inconsistent with how it is expected to be used by the `TypeEngine.ts`. Furthermore, broken exports in `index.ts` and broken test typings compound the build environment instability. A full environment rebuild (e.g., clearing pnpm cache and rebuilding) is strongly suggested to resolve the cached VITE resolutions and type resolution path issues.
