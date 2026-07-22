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
  import { Handle, Position, useSvelteFlow, type NodeProps } from "@xyflow/svelte";
  import { getContext } from "svelte";
  import { DIAGRAM_CONTEXT_KEY, type Diagram } from "../Diagram.svelte";
  import { getNodeDiagnosticSummary } from "../conversion/typeDiagnostics";

  let { id, data, selected, isConnectable }: NodeProps = $props();
  const diagram = getContext<Diagram>(DIAGRAM_CONTEXT_KEY);
  
  // Usiamo l'API nativa per aggiornare i dati del nodo senza impazzire con classi esterne
  const { updateNodeData } = useSvelteFlow();

  // Reattività nativa Svelte 5 basata sul payload "data"
  let inputsCount = $derived((data.inputsCount as number) || 2);
  let name = $derived((data.name as string) || "Join");
  let isNodeHovered = $state(false);

  let outputShape = $derived.by(() => {
    const ann = diagram?.typeResult?.annotations.get(id);
    if (!ann?.outputType) return null;
    return ann.outputType.shape.map(d => d.kind === 'const' ? String(d.value) : d.kind === 'symbolic' ? d.name : d.kind).join(',');
  });

  function focusInSidebar() {
    diagram.nodes = diagram.nodes.map((n) => ({
      ...n,
      selected: n.id === id,
    }));
  }

  let nodeDiagnostic = $derived(
    getNodeDiagnosticSummary(diagram?.typeResult ?? null, id),
  );

  function increase(e: Event) {
    e.stopPropagation();
    updateNodeData(id, { inputsCount: inputsCount + 1 });
  }

  function decrease(e: Event) {
    e.stopPropagation();
    if (inputsCount > 2) {
      updateNodeData(id, { inputsCount: inputsCount - 1 });
    }
  }
</script>

<div class="node-wrapper" class:selected style="position: relative;" onmouseenter={() => isNodeHovered = true} onmouseleave={() => isNodeHovered = false}>
  <button class="btn-branch" onclick={decrease} disabled={inputsCount <= 2}>
    -
  </button>

  <div class="join-center">
    {#each Array(inputsCount) as _, i}
      <Handle
        type="target"
        position={Position.Top}
        id={`in-${i}`}
        {isConnectable}
        style="left: {((i + 1) * 100) / (inputsCount + 1)}%;"
      />
    {/each}

    <div class="join-line" style="width: {inputsCount * 30}px;"></div>

    <div class="output-handle-wrapper">
      <Handle type="source" position={Position.Bottom} id="out" {isConnectable} />
      {#if isNodeHovered && outputShape}
        <div class="shape-tooltip">[{outputShape}]</div>
      {/if}
    </div>
  </div>

  <button class="btn-branch" onclick={increase}>+</button>

  <div class="join-label" title={name}>
    {name.length > 8 ? name.slice(0, 8) + '...' : name}
  </div>

  {#if nodeDiagnostic}
    <div class="node-indicator {nodeDiagnostic.severity}" title={nodeDiagnostic.message}>
      {nodeDiagnostic.severity === "suggestion" ? "?" : "!"}
    </div>
  {/if}
</div>

<style>
  @import "../styles/join.css";
</style>
