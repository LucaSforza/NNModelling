# Bug Report: Tensor Shape Tooltip Visibility Misconfiguration

**Context:**
The tensor shape tooltip (displaying the inferred output shape, e.g., `[$B, 784]`) appears when hovering over the output handle of a node. This behavior is inconsistent with the requirement that it should only appear when hovering over the main node body, not when exclusively hovering the handle. This seems to be the case primarily for the Input node, but the logic likely affects all nodes using `CustomNode.svelte`.

**Location of Suspected Bug:**
`front-end/src/nodes/CustomNode.svelte`

**Specific Problem Area (Current State):**
The visibility logic is controlled by mouse events directly on the output handle wrapper:
```svelte
<div class="output-handle-wrapper" onmouseenter={showTooltip} onmouseleave={hideTooltip}>
  <Handle type="source" id="out" position={Position.Bottom} {isConnectable} />
  {#if tooltipVisible && outputShape}
    <div class="shape-tooltip">[{outputShape}]</div>
  {/if}
</div>
```
This attaches the visibility trigger (`showTooltip`/`hideTooltip`) to the handle wrapper, causing the tooltip to show whenever the output handle is hovered, even if the node body is not being hovered.

**Desired Fix:**
The visibility of the tooltip should be governed by a hover state tracked on the main node body (`.node-body` element).
1.  Introduce a state variable (e.g., `$state boolean isNodeHovered`).
2.  Attach `onmouseenter` and `onmouseleave` handlers to the `.node-body` div to set `isNodeHovered`. These handlers should also call `showTooltip()` and `hideTooltip()` respectively to maintain the existing 200ms display delay on show, and instant hide on leave.
3.  Remove `onmouseenter`/`onmouseleave` from the `.output-handle-wrapper` div.
4.  The tooltip rendering condition (`#if ...`) should use this new `isNodeHovered` state, ensuring it only renders when the node body is hovered.

**Impact:**
This change ensures that the type hint tooltip is only displayed when the user's intent is to inspect the node itself, not just the connection point.

**Report Created By:** opencode agent.
**Date:** July 6, 2026
