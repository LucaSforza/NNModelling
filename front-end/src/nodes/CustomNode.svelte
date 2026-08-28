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
  import { getContext } from "svelte";
  import { DIAGRAM_CONTEXT_KEY, type Diagram } from "../Diagram.svelte";
  import { packageDiagnostic, packageOutputLabel } from "../type-system/graph/presentation";

  let { data, selected, isConnectable, id }: NodeProps = $props();
  const diagram = getContext<Diagram>(DIAGRAM_CONTEXT_KEY);
  let isNodeHovered = $state(false);
  let targetPosition = $derived(
    diagram.layoutDirection === "horizontal" ? Position.Left : Position.Top,
  );
  let sourcePosition = $derived(
    diagram.layoutDirection === "horizontal" ? Position.Right : Position.Bottom,
  );

  // Svelte 5: Filtriamo dinamicamente i parametri per posizione
  let packageMetadata = $derived.by(() => {
    const identity = data.package as { id?: unknown; version?: unknown } | undefined;
    if (!identity) return null;
    return diagram?.packageCatalog.find((metadata) => metadata.id === identity.id && metadata.version === identity.version) ?? null;
  });
  let isInput = $derived(packageMetadata?.definition.kind === "input");

  function displayParams(position: "top" | "bottom") {
    const params = (data.params as Record<string, unknown> | undefined) ?? {};
    if (packageMetadata) {
      return Object.entries(packageMetadata.definition.parameters)
        .filter(([, definition]) => definition.position === position)
        .map(([key]) => [key, params[key]] as const);
    }
    return [];
  }

  let topParams = $derived(displayParams("top"));
  let bottomParams = $derived(displayParams("bottom"));

  function focusInSidebar() {
    diagram.nodes = diagram.nodes.map((n) => ({
      ...n,
      selected: n.id === id,
    }));
  }

  // --- Type error indicator ---
  let nodeDiagnostic = $derived(
    packageDiagnostic(diagram?.typeResult ?? null, id),
  );

  // --- Shape tooltip on output handle ---
  let outputShape = $derived.by(() => {
    return packageOutputLabel(diagram?.typeResult ?? null, id);
  });
</script>

<NodeResizer
  minWidth={140}
  minHeight={80}
  isVisible={selected && !isInput}
/>

{#if !isInput}
  <Handle type="target" id="in" position={targetPosition} {isConnectable} />
{/if}

{#if isInput}
  <div class="input-circle" style="position: relative;"><div class="input-label">{data.name}</div></div>
{:else}
  <div class="node-body"
     style="background-color: {(data.color as string) || 'white'};
            color: {(data.color as string) ? 'white' : 'black'};
            text-shadow: {(data.color as string) ? '1px 1px 2px rgba(0,0,0,0.8)' : 'none'};
            position: relative;"
     onmouseenter={() => isNodeHovered = true}
     onmouseleave={() => isNodeHovered = false}
   >
    <div class="params-container top-params">
      {#each topParams as [key, param]}
        <div class="param-row"><span class="param-key">{key}</span><span class="param-value">{String(param ?? "")}</span></div>
      {/each}
    </div>
    <div class="node-title">{data.name || "Senza Nome"}</div>
    <div class="params-container bottom-params">
      {#each bottomParams as [key, param]}
        <div class="param-row"><span class="param-key">{key}</span><span class="param-value">{String(param ?? "")}</span></div>
      {/each}
    </div>
  </div>
{/if}

{#if nodeDiagnostic}
  <div class="node-indicator {nodeDiagnostic.severity}" title={nodeDiagnostic.message}>
    !
  </div>
{/if}

<!-- Loss remains terminal for the objective program, but its source handle and
     rank-1 output expose the conceptual result in the visual type system. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="output-handle-wrapper" onmouseenter={() => isNodeHovered = true} onmouseleave={() => isNodeHovered = false}>
  <Handle type="source" id="out" position={sourcePosition} {isConnectable} />
  {#if isNodeHovered && outputShape}
    <div class="shape-tooltip">{outputShape}</div>
  {/if}
</div>
<style>
  @import "../styles/node.css";
</style>
