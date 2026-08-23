<!--
  NNModelling — visual shell for nodes connected by a docking gesture.

  The Svelte Flow layer nodes remain the interactive source of truth. This
  component only draws the group boundary around those nodes, so DiagramCore
  can keep its ordinary edge graph for inference, persistence and validation.
-->

<script lang="ts">
  import type { Diagram } from "../Diagram.svelte";

  type Props = {
    diagram: Diagram;
    host: HTMLElement | undefined;
  };

  type DockedGroupGeometry = {
    key: string;
    left: number;
    top: number;
    width: number;
    height: number;
  };

  let { diagram, host }: Props = $props();
  let geometries = $state<DockedGroupGeometry[]>([]);

  let dockedGroups = $derived.by(() => {
    const nodes = diagram.nodes;
    const edges = diagram.edges;
    const visibleIds = new Set(
      nodes
        .filter((node) => !node.hidden && diagram.isLayerNode(node))
        .map((node) => node.id),
    );
    const adjacency = new Map<string, Set<string>>();

    for (const edge of edges) {
      if (!diagram.isDockedEdge(edge) || !visibleIds.has(edge.source) || !visibleIds.has(edge.target)) {
        continue;
      }
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
      if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    }

    const groups: string[][] = [];
    const visited = new Set<string>();
    for (const start of adjacency.keys()) {
      if (visited.has(start)) continue;
      const group: string[] = [];
      const queue = [start];
      visited.add(start);
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) continue;
        group.push(current);
        for (const neighbour of adjacency.get(current) ?? []) {
          if (visited.has(neighbour)) continue;
          visited.add(neighbour);
          queue.push(neighbour);
        }
      }
      if (group.length > 1) groups.push(group.sort());
    }

    return groups.map((nodeIds) => ({
      key: nodeIds.join("-"),
      nodeIds,
    }));
  });

  function measureGroups(): void {
    if (!host) {
      geometries = [];
      return;
    }

    const hostRect = host.getBoundingClientRect();
    const domNodes = new Map(
      Array.from(host.querySelectorAll<HTMLElement>(".svelte-flow__node[data-id]")).map(
        (node) => [node.dataset.id, node] as const,
      ),
    );

    geometries = dockedGroups.flatMap(({ key, nodeIds }) => {
      const rects = nodeIds
        .map((nodeId) => domNodes.get(nodeId)?.getBoundingClientRect())
        .filter((rect): rect is DOMRect => rect !== undefined && rect.width > 0 && rect.height > 0);
      if (rects.length < 2) return [];

      const left = Math.min(...rects.map((rect) => rect.left)) - hostRect.left - 10;
      const top = Math.min(...rects.map((rect) => rect.top)) - hostRect.top - 10;
      const right = Math.max(...rects.map((rect) => rect.right)) - hostRect.left + 10;
      const bottom = Math.max(...rects.map((rect) => rect.bottom)) - hostRect.top + 10;
      return [{ key, left, top, width: right - left, height: bottom - top }];
    });
  }

  $effect(() => {
    // Reading the derived groups makes this effect rerun after docking,
    // loading and deleting edges. DOM observers cover node movement and zoom.
    dockedGroups;
    diagram.nodes;
    diagram.edges;
    host;
    measureGroups();
    if (!host) return;

    let frame = 0;
    const scheduleMeasure = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measureGroups();
      });
    };
    const observer = new MutationObserver((mutations) => {
      if (mutations.some(({ target }) => {
        return target instanceof Element && !target.closest(".docked-groups");
      })) {
        scheduleMeasure();
      }
    });
    observer.observe(host, { attributes: true, childList: true, subtree: true });
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(host);

    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  });
</script>

<div class="docked-groups" aria-hidden="true">
  {#each geometries as group (group.key)}
    <div
      class="docked-group"
      data-docked-group={group.key}
      style:left={`${group.left}px`}
      style:top={`${group.top}px`}
      style:width={`${group.width}px`}
      style:height={`${group.height}px`}
    ></div>
  {/each}
</div>

<style>
  .docked-groups {
    position: absolute;
    inset: 0;
    z-index: 4;
    pointer-events: none;
  }

  .docked-group {
    position: absolute;
    box-sizing: border-box;
    border: 2px solid rgba(37, 99, 235, 0.72);
    border-radius: 14px;
    background: rgba(37, 99, 235, 0.035);
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.11);
  }
</style>
