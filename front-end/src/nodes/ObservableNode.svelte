<script lang="ts">
  import { Handle, Position, NodeResizer, type NodeProps } from "@xyflow/svelte";
  import { getContext } from "svelte";
  import { DIAGRAM_CONTEXT_KEY, type Diagram } from "../Diagram.svelte";
  import { getNodeDiagnosticSummary } from "../conversion/typeDiagnostics";

  let { data, selected, isConnectable, id }: NodeProps = $props();
  const diagram = getContext<Diagram>(DIAGRAM_CONTEXT_KEY);
  const stereotype = $derived(diagram?.getStereotype(String(data.stereotype)));
  const inputs = $derived(stereotype?.observable?.inputs ?? []);
  const enabled = $derived(data.enabled !== false);
  const diagnostic = $derived(getNodeDiagnosticSummary(diagram?.typeResult ?? null, id));

  function focusInSidebar() {
    diagram.nodes = diagram.nodes.map((node) => ({ ...node, selected: node.id === id }));
  }
</script>

<NodeResizer minWidth={190} minHeight={80} isVisible={selected} />

<div
  class:observable-disabled={!enabled}
  class="observable-node"
  role="button"
  aria-label={`${data.name ?? "Observable"} observation node`}
  aria-disabled={!enabled}
  onclick={focusInSidebar}
  onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") focusInSidebar(); }}
  tabindex="0"
>
  <div class="observable-handles" aria-label="Observable inputs">
    {#each inputs as input, index (input.id)}
      <div class="observable-input" style:left={`${((index + 1) * 100) / (inputs.length + 1)}%`}>
        <Handle type="target" position={Position.Top} id={input.id} {isConnectable} style="background: #7c3aed; border-color: #4c1d95;" />
        <span>{input.label}</span>
      </div>
    {/each}
  </div>
  <div class="observable-title"><span aria-hidden="true">◉</span> {data.name ?? "Observable"}</div>
  <div class="observable-stereotype">{data.stereotype}</div>
  {#if !enabled}<div class="observable-paused" aria-label="Observable paused">⏸ Paused</div>{/if}
</div>

{#if diagnostic}
  <div class="node-indicator {diagnostic.severity}" title={diagnostic.message}>{diagnostic.severity === "suggestion" ? "?" : "!"}</div>
{/if}

<style>
  @import "../styles/observable.css";
</style>
