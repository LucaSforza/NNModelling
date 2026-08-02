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
    SvelteFlow,
    MarkerType,
    Controls,
    Background,
    Panel,
    useSvelteFlow,
    type Connection,
    type Edge,
  } from "@xyflow/svelte";

  import Sidebar from "./components/Sidebar.svelte";
  import TrainingSidebar from "./components/TrainingSidebar.svelte";
  import { onMount } from "svelte";
  import { projectState } from "./projects/state.svelte";

  const { getInternalNode, getIntersectingNodes, screenToFlowPosition, fitView, setCenter } =
    useSvelteFlow();

  import CustomNode from "./nodes/CustomNode.svelte";
  import SubflowNode from "./nodes/SubflowNode.svelte";
  import JoinNode from "./nodes/JoinNode.svelte";
  import {
    checkValidConnection,
    handleLoadModel,
    handleSaveModel,
    onNodeDragStop,
  } from "./utils";

  import { NNTree } from "./conversion/nnTree";

  // 1. Importiamo la classe Diagram
  import { Diagram, DIAGRAM_CONTEXT_KEY } from "./Diagram.svelte";
  import { setContext } from "svelte";
  import { toPng } from "html-to-image";

  // RPC handler — receives MCP server requests and dispatches to Diagram
  import { BrowserRPCHandler } from "./sync/BrowserRPCHandler";

  const nodeTypes = {
    custom: CustomNode,
    subflow: SubflowNode,
    join: JoinNode,
  };

  // 2. Istanziamo il nostro "Controller/Model"
  // Grazie a Svelte 5, le sue proprietà interne $state saranno reattive qui dentro!
  const diagram = new Diagram();

  interface Props {
    onOpenProjectChooser?: () => void;
  }

  let { onOpenProjectChooser }: Props = $props();

  // Context per SubflowNode — gli permette di chiamare diagram.toggleSubflow
  // senza bisogno di callback nel node data
  setContext(DIAGRAM_CONTEXT_KEY, diagram);

  // Ripristino del progetto attivo all'avvio: il diagramma e il catalogo
  // stereotipi vengono sostituiti solo dopo la validazione atomica.
  onMount(() => {
    projectState.attachDiagram(diagram);
    void projectState.restore();
  });

  let hasActiveProject = $derived(projectState.active !== null);
  // Save is only meaningful once the active project has actually been applied
  // (diagram + catalog). A failed restore leaves the project visible but
  // unapplied; saving must stay disabled so the browser diagram cannot
  // overwrite the project graph.
  let canSaveProject = $derived(projectState.active !== null && projectState.status === "ready");

  async function handleProjectSave() {
    await projectState.saveGraph();
  }

  function handleOpenProjectChooser() {
    onOpenProjectChooser?.();
  }

  // --- SVELTE 5: Stato derivato per abilitare/disabilitare i pulsanti ---
  // Ora peschiamo direttamente dall'istanza diagram
  let selectedNodes = $derived(diagram.nodes.filter((n) => n.selected));
  let selectedEdges = $derived(diagram.edges.filter((e) => e.selected));

  let hasSelection = $derived(
    selectedNodes.length > 0 || selectedEdges.length > 0,
  );

  let activeNode = $derived(
    selectedNodes.length === 1 ? selectedNodes[0] : null,
  );

  let isSidebarOpen = $state(false);
  let activeMode = $state<"nodes" | "training">("nodes");
  let loadError = $state<string | null>(null);
  let canvasRef: HTMLDivElement;

  // Auto-apertura quando si seleziona un nodo
  $effect(() => {
    if (activeNode && activeMode === "nodes") {
      isSidebarOpen = true;
    }
  });

  // Connessione WebSocket per gestire richieste RPC dal MCP server
  let syncClient: BrowserRPCHandler;

  $effect(() => {
    syncClient = new BrowserRPCHandler(diagram, undefined, { fitView, setCenter });
    syncClient.connect();
    return () => syncClient.disconnect();
  });

  // Forziamo il ricalcolo della vista su ogni cambiamento strutturale
  $effect(() => {
    const unsubscribe = diagram.onGraphChanged(() => {
      fitView({ maxZoom: 1, padding: 0.2 });
    });
    return unsubscribe;
  });

  function handleKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }
    // Ctrl+Alt+Z = Redo (check BEFORE Ctrl+Z)
    if (e.ctrlKey && e.altKey && e.key === 'z') {
      e.preventDefault();
      diagram.redo();
      return;
    }
    // Ctrl+Z = Undo
    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault();
      diagram.undo();
      return;
    }
  }
  function getSpawnPosition() {
    // Troviamo il centro della finestra e lo convertiamo in coordinate del canvas
    const center = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });

    // Aggiungiamo un offset randomico tra -30px e +30px per non sovrapporli esattamente
    return {
      x: center.x + (Math.random() * 60 - 30),
      y: center.y + (Math.random() * 60 - 30),
    };
  }

  function handleAddSubGraph() {
    const pos = getSpawnPosition();
    diagram.addSubGraph(pos.x, pos.y);
  }

  function deleteSelectedElements() {
    if (selectedNodes.length > 0)
      diagram.deleteNodes(selectedNodes.map((n) => n.id));

    if (selectedEdges.length > 0)
      diagram.deleteEdges(selectedEdges.map((e) => e.id));
  }

  async function handleExportPng() {
    if (!canvasRef) return;

    const dataUrl = await toPng(canvasRef, {
      backgroundColor: "#ffffff",
      filter: (element) => {
        return (
          !element.classList?.contains("toolbar") &&
          !element.classList?.contains("svelte-flow__controls")
        );
      },
    });

    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = "diagram.png";
    link.click();
  }

  async function handleConversion() {
    const typeResult = diagram.refreshTypes();
    const blockingErrors = typeResult.errors.filter(
      (error) => error.severity === "error",
    );
    if (blockingErrors.length > 0) {
      const summary = blockingErrors
        .slice(0, 5)
        .map((error) => `${error.nodeId || "graph"}: ${error.message}`)
        .join("\n");
      alert(`Conversione bloccata da ${blockingErrors.length} errori di tipo:\n${summary}`);
      return;
    }

    const nnTree = new NNTree(diagram);
    const data = nnTree.toJson();

    // Controlla se showSaveFilePicker esiste (Chrome/Edge)
    if ("showSaveFilePicker" in window) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: "nnTree.json",
          types: [{ accept: { "application/json": [".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
        return;
      } catch (e) {
        console.warn("L'utente ha chiuso la finestra o c'è stato un errore.");
        return;
      }
    }

    // Fallback per Firefox e browser vecchi
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "nnTree.json";
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

<div class="editor-layout">
  <div class="canvas-container" bind:this={canvasRef}>
    <SvelteFlow
      bind:nodes={diagram.nodes}
      bind:edges={diagram.edges}
      {nodeTypes}
      defaultEdgeOptions={{
        markerEnd: { type: MarkerType.ArrowClosed },
      }}
      isValidConnection={(conn: Connection | Edge) =>
        checkValidConnection(diagram, conn)}
      onnodedragstop={(payload) => {
        let newNodes = onNodeDragStop(
          payload,
          diagram.nodes,
          getIntersectingNodes,
          getInternalNode,
        );
        if (newNodes !== undefined) diagram.nodes = newNodes;
        diagram.refreshTypes();
      }}
      onconnect={() => {
        diagram.refreshTypes();
      }}
      ondelete={() => {
        diagram.refreshTypes();
      }}
      fitView
      fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
    >
      <Background />
      <Controls />
      <Panel position="top-left" class="toolbar">
        <button
          onclick={() => void handleProjectSave()}
          disabled={!canSaveProject}
          title={canSaveProject ? "Salva nel progetto attivo" : hasActiveProject ? "Il progetto non è stato applicato: riaprilo prima di salvare" : "Apri o crea un progetto per salvare"}
          class="toolbar-btn"
          >💾 Salva</button
        >
        <button onclick={() => handleSaveModel(diagram)} class="toolbar-btn"
          >⬇️ Esporta JSON</button
        >
        <button
          onclick={() => {
            loadError = null;
            handleLoadModel(
              diagram,
              () => diagram.refreshTypes(),
              (message) => (loadError = message),
            );
            isSidebarOpen = false;
          }}
          class="toolbar-btn">📂 Carica</button
        >
        <button onclick={handleOpenProjectChooser} class="toolbar-btn"
          >📁 Progetto</button
        >
        {#if loadError}
          <div class="load-error" role="alert">{loadError}</div>
        {/if}
        <button onclick={handleConversion} class="toolbar-btn"
          >📦 Converti in Python</button
        >
        <button onclick={handleExportPng} class="toolbar-btn"
          >🖼️ Esporta PNG</button
        >
        <button onclick={handleAddSubGraph} class="toolbar-btn"
          >📦 Aggiungi SubGraph</button
        >
        <button
          onclick={deleteSelectedElements}
          disabled={!hasSelection}
          class:danger={hasSelection}
        >
          ❌ Elimina
        </button>
      </Panel>
      <Panel position="top-right">
        <button
          class="training-mode-btn"
          onclick={() => {
            activeMode = "training";
            isSidebarOpen = false;
          }}
        >
          🧪 Training
        </button>
        <button
          class="toggle-sidebar-btn"
          onclick={() => (isSidebarOpen = !isSidebarOpen)}
        >
          {isSidebarOpen ? "Nascondi Proprietà" : "⚙️ Mostra Proprietà"}
        </button>
      </Panel>
    </SvelteFlow>
  </div>

  {#if activeMode === "nodes"}
    <Sidebar
      {diagram}
      selectedNode={activeNode}
      isOpen={isSidebarOpen}
      onClose={() => (isSidebarOpen = false)}
      {getSpawnPosition}
    />
  {:else}
    <TrainingSidebar
      {diagram}
      onClose={() => (activeMode = "nodes")}
    />
  {/if}
</div>

<style>
  @import "./styles/flowcanvas.css";

  .training-mode-btn {
    margin-right: 8px;
  }

  .load-error {
    max-width: 360px;
    margin-top: 8px;
    padding: 8px 10px;
    border: 1px solid #d33;
    border-radius: 4px;
    background: #fff1f1;
    color: #a00;
    font-size: 0.85rem;
    white-space: normal;
  }
</style>
