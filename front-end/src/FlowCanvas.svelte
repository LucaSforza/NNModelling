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
    useUpdateNodeInternals,
    type Connection,
    type Edge,
  } from "@xyflow/svelte";

  import Sidebar from "./components/Sidebar.svelte";
  import TrainingSidebar from "./components/TrainingSidebar.svelte";

  const {
    getInternalNode,
    getIntersectingNodes,
    screenToFlowPosition,
    fitView,
    setCenter,
    getViewport,
    setViewport,
    getNodesBounds,
  } = useSvelteFlow();
  const updateNodeInternals = useUpdateNodeInternals();

  import CustomNode from "./nodes/CustomNode.svelte";
  import SubflowNode from "./nodes/SubflowNode.svelte";
  import JoinNode from "./nodes/JoinNode.svelte";
  import EditableEdge from "./edges/EditableEdge.svelte";
  import {
    checkValidConnection,
    handleLoadModel,
    handleSaveModel,
    onNodeDragStop,
  } from "./utils";


  // 1. Importiamo la classe Diagram
  import { Diagram, DIAGRAM_CONTEXT_KEY } from "./Diagram.svelte";
  import { setContext, tick } from "svelte";
  import type { LayoutDirection } from "./layout/autoLayout";
  import { toBlob, toPng } from "html-to-image";
  import {
    getPngEdgeStyle,
    getPngExportLayout,
    shouldIncludePngElement,
  } from "./pngExport";

  // RPC handler — receives MCP server requests and dispatches to Diagram
  import { BrowserRPCHandler } from "./sync/BrowserRPCHandler";

  const nodeTypes = {
    custom: CustomNode,
    subflow: SubflowNode,
    join: JoinNode,
  };

  // Keep this module-level mapping stable so Svelte Flow does not recreate
  // edge renderers during unrelated canvas updates.
  const edgeTypes = {
    editable: EditableEdge,
  };

  // 2. Istanziamo il nostro "Controller/Model"
  // Grazie a Svelte 5, le sue proprietà interne $state saranno reattive qui dentro!
  const diagram = new Diagram();

  // Context per SubflowNode — gli permette di chiamare diagram.toggleSubflow
  // senza bisogno di callback nel node data
  setContext(DIAGRAM_CONTEXT_KEY, diagram);

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
  let layoutError = $state<string | null>(null);
  let isLayoutMenuOpen = $state(false);
  let canvasRef: HTMLDivElement;
  let layoutControlRef: HTMLDivElement;
  let layoutButtonRef: HTMLButtonElement;
  let layoutMenuRef = $state<HTMLDivElement>();
  let canvasSyncGeneration = 0;

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

  async function synchronizeCanvasAfterGraphChange(): Promise<void> {
    const generation = ++canvasSyncGeneration;
    await tick();
    if (generation !== canvasSyncGeneration) return;

    updateNodeInternals(diagram.nodes.map((node) => node.id));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (generation !== canvasSyncGeneration) return;

    await fitView({ maxZoom: 1, padding: 0.2 });
  }

  // Graph mutations notify synchronously. Defer Svelte Flow cache and viewport
  // work until the new node markup and directional handles are in the DOM.
  $effect(() => {
    const unsubscribe = diagram.onGraphChanged(() => {
      void synchronizeCanvasAfterGraphChange();
    });
    return () => {
      canvasSyncGeneration += 1;
      unsubscribe();
    };
  });

  function handleAutoLayout(direction: LayoutDirection): void {
    layoutError = null;
    isLayoutMenuOpen = false;
    try {
      diagram.autoLayout(direction);
    } catch (error) {
      layoutError = error instanceof Error
        ? error.message
        : "Impossibile disporre automaticamente il diagramma.";
    }
  }

  async function openLayoutMenuAndFocusFirst(): Promise<void> {
    isLayoutMenuOpen = true;
    await tick();
    layoutMenuRef?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus();
  }

  function handleLayoutButtonKeyDown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      void openLayoutMenuAndFocusFirst();
    }
  }

  function handleLayoutMenuKeyDown(event: KeyboardEvent): void {
    const items = Array.from(
      layoutMenuRef?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
    );
    if (items.length === 0) return;
    const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    let nextIndex: number | undefined;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex !== undefined) {
      event.preventDefault();
      items[nextIndex].focus();
    }
  }

  function handleDocumentClick(event: MouseEvent): void {
    if (
      isLayoutMenuOpen &&
      event.target instanceof Node &&
      !layoutControlRef?.contains(event.target)
    ) {
      isLayoutMenuOpen = false;
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }
    if (e.key === "Escape" && isLayoutMenuOpen) {
      e.preventDefault();
      isLayoutMenuOpen = false;
      layoutButtonRef?.focus();
      return;
    }
    // Ctrl+Alt+Z = Redo (check BEFORE Ctrl+Z)
    if (e.ctrlKey && e.altKey && e.code === 'KeyZ') {
      e.preventDefault();
      diagram.redo();
      return;
    }
    // Ctrl+Z = Undo
    if (e.ctrlKey && e.code === 'KeyZ') {
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
    alert("I subflow richiedono un package attivo; seleziona un package Subflow dalla sidebar.");
  }

  function deleteSelectedElements() {
    if (selectedNodes.length > 0)
      diagram.deleteNodes(selectedNodes.map((n) => n.id));

    if (selectedEdges.length > 0)
      diagram.deleteEdges(selectedEdges.map((e) => e.id));
  }

  function inlinePngEdgeStyles(container: HTMLElement): () => void {
    const paths = Array.from(
      container.querySelectorAll<SVGPathElement>(".svelte-flow__edge-path"),
    );
    const originalStyles = paths.map((path) => ({
      path,
      style: path.getAttribute("style"),
    }));

    for (const path of paths) {
      const style = getPngEdgeStyle(getComputedStyle(path));
      path.style.stroke = style.stroke;
      path.style.strokeWidth = style.strokeWidth;
      path.style.fill = style.fill;
    }

    return () => {
      for (const { path, style } of originalStyles) {
        if (style === null) path.removeAttribute("style");
        else path.setAttribute("style", style);
      }
    };
  }

  async function handleExportPng() {
    if (!canvasRef || diagram.nodes.length === 0) return;

    const visibleNodes = diagram.nodes.filter((node) => !node.hidden);
    const bounds = getNodesBounds(visibleNodes);
    const layout = getPngExportLayout(bounds);
    const originalViewport = getViewport();
    const originalWidth = canvasRef.style.width;
    const originalHeight = canvasRef.style.height;
    const restoreEdgeStyles = inlinePngEdgeStyles(canvasRef);

    try {
      canvasRef.style.width = `${layout.width}px`;
      canvasRef.style.height = `${layout.height}px`;
      await tick();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      await setViewport(layout.viewport);
      await tick();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const pngOptions = {
        width: layout.width,
        height: layout.height,
        canvasWidth: layout.width,
        canvasHeight: layout.height,
        backgroundColor: "#ffffff",
        filter: shouldIncludePngElement,
      };
      let blob = await toBlob(canvasRef, pngOptions);
      if (!blob) {
        const dataUrl = await toPng(canvasRef, pngOptions);
        blob = await (await fetch(dataUrl)).blob();
      }
      if (!blob) return;

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "diagram.png";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      restoreEdgeStyles();
      canvasRef.style.width = originalWidth;
      canvasRef.style.height = originalHeight;
      await tick();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await setViewport(originalViewport);
    }
  }

  async function handleConversion() {
    alert("Conversione non disponibile: il backend package non è ancora installato.");
  }
</script>

<svelte:window onkeydown={handleKeyDown} />
<svelte:document onclick={handleDocumentClick} />

<div class="editor-layout">
  <div class="canvas-container" bind:this={canvasRef}>
    <SvelteFlow
      bind:nodes={diagram.nodes}
      bind:edges={diagram.edges}
      {nodeTypes}
      {edgeTypes}
      defaultEdgeOptions={{
        type: "editable",
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
          diagram.edges,
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
        <button onclick={() => handleSaveModel(diagram)} class="toolbar-btn"
          >💾 Salva</button
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
        <div class="layout-control" bind:this={layoutControlRef}>
          <button
            bind:this={layoutButtonRef}
            type="button"
            class="toolbar-btn"
            aria-haspopup="menu"
            aria-expanded={isLayoutMenuOpen}
            aria-controls="layout-direction-menu"
            onclick={() => (isLayoutMenuOpen = !isLayoutMenuOpen)}
            onkeydown={handleLayoutButtonKeyDown}
          >
            ↔️ Disponi
          </button>
          {#if isLayoutMenuOpen}
            <div
              bind:this={layoutMenuRef}
              id="layout-direction-menu"
              class="layout-menu"
              role="menu"
              tabindex="-1"
              aria-label="Direzione disposizione automatica"
              onkeydown={handleLayoutMenuKeyDown}
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={diagram.layoutDirection === "vertical"}
                onclick={() => handleAutoLayout("vertical")}
              >Verticale</button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={diagram.layoutDirection === "horizontal"}
                onclick={() => handleAutoLayout("horizontal")}
              >Orizzontale</button>
            </div>
          {/if}
        </div>
        {#if layoutError}
          <div class="layout-error" role="alert">{layoutError}</div>
        {/if}
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

  .layout-error {
    max-width: 360px;
    padding: 8px 10px;
    border: 1px solid #d33;
    border-radius: 4px;
    background: #fff1f1;
    color: #a00;
    font-size: 0.85rem;
    white-space: normal;
  }
</style>
