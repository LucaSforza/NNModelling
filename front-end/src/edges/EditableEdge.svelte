<!--
NNModelling — DSL for designing neural networks via visual node editor
Copyright (C) 2026  Luca Sforza

Licensed under the GNU General Public License v3 or later.
Commercial licenses are available — contact Luca Sforza.
See the LICENSE file for details.
-->

<script lang="ts">
  import { BaseEdge, useSvelteFlow, type EdgeProps } from "@xyflow/svelte";
  import { getContext } from "svelte";
  import { DIAGRAM_CONTEXT_KEY, type Diagram } from "../Diagram.svelte";
  import { routePointsFromData } from "../core/edgeRoute";
  import { getOrthogonalRoutePath, type RoutePoint } from "./routePath";

  type Gesture = {
    pointerId: number;
    target: SVGElement;
    pointIndex: number;
    points: RoutePoint[];
    moved: boolean;
  };

  let {
    id,
    source,
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    data = {},
    selected = false,
    markerStart,
    markerEnd,
    interactionWidth,
    style,
  }: EdgeProps = $props();

  const diagram = getContext<Diagram>(DIAGRAM_CONTEXT_KEY);
  const { getInternalNode, screenToFlowPosition } = useSvelteFlow();
  let previewPoints = $state<RoutePoint[] | null>(null);
  let gesture = $state<Gesture | null>(null);

  let persistedPoints = $derived(routePointsFromData(data));
  let displayedPoints = $derived(previewPoints ?? persistedPoints);
  let scopeOrigin = $derived.by(() => {
    // Track endpoints and diagram state: both change when a containing scope moves.
    void sourceX;
    void targetX;
    const sourceNode = diagram.nodes.find((node) => node.id === source);
    const scopeId = sourceNode?.parentId;
    if (!scopeId) return { x: 0, y: 0 };
    const internalScope = getInternalNode(scopeId);
    return internalScope?.internals.positionAbsolute
      ?? diagram.nodes.find((node) => node.id === scopeId)?.position
      ?? { x: 0, y: 0 };
  });
  let path = $derived(getOrthogonalRoutePath({
    source: { x: sourceX, y: sourceY },
    target: { x: targetX, y: targetY },
    sourcePosition,
    targetPosition,
    points: displayedPoints,
    scopeOrigin,
  }));
  let controlAnchor = $derived({
    x: (sourceX + targetX) / 2,
    y: (sourceY + targetY) / 2,
  });

  function localPointerPoint(event: PointerEvent): RoutePoint {
    const point = screenToFlowPosition(
      { x: event.clientX, y: event.clientY },
      { snapToGrid: false },
    );
    return { x: point.x - scopeOrigin.x, y: point.y - scopeOrigin.y };
  }

  function stopCanvasGesture(event: PointerEvent | MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  function beginGesture(event: PointerEvent, pointIndex: number, points: RoutePoint[]): void {
    if (!selected || gesture) return;
    stopCanvasGesture(event);
    const target = event.currentTarget as SVGElement;
    target.setPointerCapture(event.pointerId);
    gesture = { pointerId: event.pointerId, target, pointIndex, points, moved: false };
    previewPoints = points.map((point) => ({ ...point }));
  }

  function beginCreate(event: PointerEvent): void {
    const point = localPointerPoint(event);
    beginGesture(event, persistedPoints.length, [...persistedPoints, point]);
  }

  function beginMove(event: PointerEvent, pointIndex: number): void {
    beginGesture(event, pointIndex, persistedPoints);
  }

  function moveGesture(event: PointerEvent): void {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    stopCanvasGesture(event);
    const point = localPointerPoint(event);
    const current = gesture.points[gesture.pointIndex];
    const moved = gesture.moved || current?.x !== point.x || current?.y !== point.y;
    previewPoints = gesture.points.map((candidate, index) => (
      index === gesture?.pointIndex ? point : { ...candidate }
    ));
    gesture = { ...gesture, moved };
  }

  function finishGesture(event: PointerEvent, cancelled = false): void {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    stopCanvasGesture(event);
    if (gesture.target.hasPointerCapture(event.pointerId)) {
      gesture.target.releasePointerCapture(event.pointerId);
    }
    // Pointer events may be coalesced, so pointerup is authoritative even when
    // no pointermove was delivered before release.
    const releasedPoint = localPointerPoint(event);
    const initialPoint = gesture.points[gesture.pointIndex];
    const completedPoints = gesture.points.map((point, index) => (
      index === gesture?.pointIndex ? releasedPoint : { ...point }
    ));
    const moved = gesture.moved ||
      initialPoint?.x !== releasedPoint.x || initialPoint?.y !== releasedPoint.y;
    const shouldCommit = !cancelled && moved;
    gesture = null;
    previewPoints = null;
    if (shouldCommit) diagram.updateEdgeRoute(id, completedPoints);
  }

  function cancelGesture(): void {
    if (!gesture) return;
    if (gesture.target.hasPointerCapture(gesture.pointerId)) {
      gesture.target.releasePointerCapture(gesture.pointerId);
    }
    gesture = null;
    previewPoints = null;
  }

  function removePoint(event: MouseEvent, pointIndex: number): void {
    event.preventDefault();
    event.stopPropagation();
    diagram.updateEdgeRoute(id, persistedPoints.filter((_, index) => index !== pointIndex));
  }

  function resetRoute(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    diagram.clearEdgeRoute(id);
  }

  function controlKeyDown(event: KeyboardEvent, callback: () => void): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    callback();
  }

  function bendKeyDown(event: KeyboardEvent, pointIndex: number): void {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      diagram.updateEdgeRoute(id, persistedPoints.filter((_, index) => index !== pointIndex));
    }
  }

  function keyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") cancelGesture();
  }
</script>

<svelte:window onkeydown={keyDown} />

<BaseEdge
  {path}
  {markerStart}
  {markerEnd}
  {interactionWidth}
  {style}
  class={{ "editable-edge-path": true, "editable-edge-path--selected": selected }}
/>

<!-- BaseEdge draws the visible route; this transparent overlay owns pointer capture. -->
<path
  d={path}
  class="editable-edge-hit-target nopan"
  role="presentation"
  fill="none"
  stroke="transparent"
  stroke-width="24"
  onpointerdown={beginCreate}
  onpointermove={moveGesture}
  onpointerup={finishGesture}
  onpointercancel={(event) => finishGesture(event, true)}
/>

{#if selected}
  <g class="editable-edge-controls nopan" data-png-exclude="true" aria-label="Edge route controls">
    {#each displayedPoints as point, index (`${index}-${point.x}-${point.y}`)}
      {@const absolutePoint = { x: point.x + scopeOrigin.x, y: point.y + scopeOrigin.y }}
      <circle
        class="editable-edge-bend"
        cx={absolutePoint.x}
        cy={absolutePoint.y}
        r="6"
        role="button"
        tabindex="0"
        aria-label={`Move bend ${index + 1}; press Delete to remove`}
        onpointerdown={(event) => beginMove(event, index)}
        onpointermove={moveGesture}
        onpointerup={finishGesture}
        onpointercancel={(event) => finishGesture(event, true)}
        onkeydown={(event) => bendKeyDown(event, index)}
      />
      <g
        class="editable-edge-remove"
        transform={`translate(${absolutePoint.x + 10}, ${absolutePoint.y - 10})`}
        role="button"
        tabindex="0"
        aria-label={`Remove bend ${index + 1}`}
        onclick={(event) => removePoint(event, index)}
        onkeydown={(event) => controlKeyDown(event, () => diagram.updateEdgeRoute(
          id,
          persistedPoints.filter((_, pointIndex) => pointIndex !== index),
        ))}
      >
        <circle r="7" />
        <path d="M -3 0 L 3 0" />
      </g>
    {/each}
    <g
      class="editable-edge-reset"
      transform={`translate(${controlAnchor.x}, ${controlAnchor.y})`}
      role="button"
      tabindex="0"
      aria-label="Reset edge route"
      onclick={resetRoute}
      onkeydown={(event) => controlKeyDown(event, () => diagram.clearEdgeRoute(id))}
    >
      <rect x="-18" y="-10" width="36" height="20" rx="4" />
      <text text-anchor="middle" dominant-baseline="central">Reset</text>
    </g>
  </g>
{/if}

<style>
  @import "../styles/editable-edge.css";
</style>
