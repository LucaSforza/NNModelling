<!--
NNModelling — DSL for designing neural networks via visual node editor
Copyright (C) 2026  Luca Sforza

Licensed under the GNU General Public License v3 or later.
Commercial licenses are available — contact Luca Sforza.
See the LICENSE file for details.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
-->

<script lang="ts">
  import {
    Handle,
    Position,
    NodeResizer,
    type NodeProps,
  } from "@xyflow/svelte";
  import { type Node } from "@xyflow/svelte";
  import { getContext } from "svelte";
  import { DIAGRAM_CONTEXT_KEY, type Diagram } from "../Diagram.svelte";
  import { packageDiagnostic } from "../type-system/graph/presentation";

  type SubflowData = {
    label: string;
    isCollapsed: boolean;
    color: any;
    params: Record<string, unknown>;
    package: { id: string; version: string; name: string };
  };

  type MySubflowNode = Node<SubflowData, "subflow">;

  let { data, selected, id }: NodeProps<MySubflowNode> = $props();
  const diagram = getContext<Diagram>(DIAGRAM_CONTEXT_KEY);
  let targetPosition = $derived(
    diagram.layoutDirection === "horizontal" ? Position.Left : Position.Top,
  );
  let sourcePosition = $derived(
    diagram.layoutDirection === "horizontal" ? Position.Right : Position.Bottom,
  );

  let topParams = $derived([] as Array<[string, unknown]>);

  let bottomParams = $derived([] as Array<[string, unknown]>);

  function focusInSidebar() {
    diagram.nodes = diagram.nodes.map((n) => ({
      ...n,
      selected: n.id === id,
    }));
  }

  let nodeDiagnostic = $derived(
    packageDiagnostic(diagram?.typeResult ?? null, id),
  );

</script>

<NodeResizer
  minWidth={200}
  minHeight={50}
  isVisible={selected}
/>

<Handle type="target" id="in" position={targetPosition} />

<div class="subflow-wrapper" class:collapsed={data.isCollapsed} style="position: relative;">
  <div
    class="subflow-header"
    style:background={String(data.color || "#007bff")}
  >
    {data.label || ""}
    <button
      class="collapse-btn"
      onclick={() => diagram.toggleSubflow(id, !data.isCollapsed)}
    >
      {data.isCollapsed ? "+" : "-"}
    </button>
  </div>

  {#if topParams.length > 0}
    <div class="params-container top-params">
      {#each topParams as [key, param]}
        <div class="param-row">
          <span class="param-key">{key}</span>
          <span class="param-value">{String(param)}</span>
        </div>
      {/each}
    </div>
  {/if}

  <div class="subflow-body"></div>

  {#if bottomParams.length > 0}
    <div class="params-container bottom-params">
      {#each bottomParams as [key, param]}
        <div class="param-row">
          <span class="param-key">{key}</span>
          <span class="param-value">{String(param)}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#if nodeDiagnostic}
    <div class="node-indicator {nodeDiagnostic.severity}" title={nodeDiagnostic.message}>
      !
    </div>
  {/if}
</div>

<Handle type="source" id="out" position={sourcePosition} />

<style>
  @import "../styles/subflow.css";
</style>
