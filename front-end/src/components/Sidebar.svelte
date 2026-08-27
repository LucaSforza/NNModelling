<!--
NNModelling — DSL for designing neural networks via visual node editor
Copyright (C) 2026  Luca Sforza

Licensed under the GNU General Public License v3 or later.
-->

<script lang="ts">
  import SDropdown from "./SDropdown.svelte";
  import type { Diagram } from "../Diagram.svelte";
  import type { Node } from "@xyflow/svelte";
  import type { ActivePackageMetadata, EditorInferenceState } from "../type-system/host";
  import type { ParameterDefinition } from "../type-system/packages/types";
  import {
    formatEditorValue,
    initialPackageParameters,
    packageIdentity,
    packageMatches,
    packageReferenceMatches,
    parameterValue,
    parseShapeOrList,
  } from "../type-system/editor/package-ui";
  import { packageDiagnostic, packageOutputLabel } from "../type-system/graph/presentation";
  import { packageIdentity as nodePackageIdentity, type GraphNodeResult } from "../type-system/graph/types";

  interface Props {
    diagram: Diagram;
    selectedNode: Node | null;
    isOpen: boolean;
    onClose: () => void;
    getSpawnPosition: () => { x: number; y: number };
  }

  let { diagram, selectedNode, isOpen, onClose, getSpawnPosition }: Props = $props();

  let form = $state({
    name: "",
    color: "#4779c4",
    width: 140,
    height: 60,
    params: {} as Record<string, unknown>,
    wheelAdapters: [] as string[],
  });
  let packageSelection = $state<ActivePackageMetadata | null>(null);
  let sidebarWidth = $state(320);
  let isDragging = $state(false);
  let lastLoadedKey = $state<string | null>(null);

  let isEditing = $derived(selectedNode !== null);
  let selectedPackageIdentity = $derived(selectedNode ? nodePackageIdentity(selectedNode) : undefined);
  let isPackageNode = $derived(selectedPackageIdentity !== undefined);
  let packageDefinition = $derived(packageSelection?.definition ?? null);
  let packageParameters = $derived(packageDefinition ? Object.entries(packageDefinition.parameters) : []);
  let packageAdapters = $derived(packageDefinition?.wheelAdapters ?? []);
  let packageOutput = $derived(selectedNode && isPackageNode
    ? packageOutputLabel(diagram.typeResult, selectedNode.id)
    : null);
  let packageState = $derived(selectedNode && isPackageNode
    ? diagram.typeResult?.nodes.get(selectedNode.id)
    : undefined);

  function startResize(event: MouseEvent) {
    isDragging = true;
    window.addEventListener("mousemove", doResize);
    window.addEventListener("mouseup", stopResize);
    event.preventDefault();
  }

  function doResize(event: MouseEvent) {
    if (!isDragging) return;
    const width = window.innerWidth - event.clientX;
    if (width > 200 && width < 600) sidebarWidth = width;
  }

  function stopResize() {
    isDragging = false;
    window.removeEventListener("mousemove", doResize);
    window.removeEventListener("mouseup", stopResize);
  }

  $effect(() => {
    const id = selectedNode?.id ?? "new";
    const key = `${id}:${diagram.packageCatalog.length}`;
    if (key === lastLoadedKey) return;
    lastLoadedKey = key;
    if (selectedNode) loadExistingNode(selectedNode);
    else resetForm();
  });

  function loadExistingNode(node: Node) {
    const identity = nodePackageIdentity(node);
    if (identity) {
      packageSelection = diagram.packageCatalog.find((metadata) => packageMatches(metadata, identity)) ?? null;
      form.name = String(node.data.name ?? node.data.label ?? packageSelection?.definition.name ?? "");
      form.color = String(node.data.color ?? packageSelection?.definition.view.color ?? "#4779c4");
      form.width = node.width ?? packageSelection?.definition.view.width ?? 140;
      form.height = node.height ?? packageSelection?.definition.view.height ?? 60;
      form.params = packageSelection
        ? initialPackageParameters(packageSelection.definition, (node.data.params as Record<string, unknown> | undefined))
        : structuredClone((node.data.params as Record<string, unknown> | undefined) ?? {});
      form.wheelAdapters = Array.isArray(node.data.wheelAdapters)
        ? node.data.wheelAdapters.filter((name: unknown): name is string => typeof name === "string")
        : [];
      return;
    }

    throw new Error("Legacy node cannot be edited; reload a package-format diagram");
  }

  function resetForm() {
    packageSelection = null;
    form.name = "";
    form.color = "#4779c4";
    form.width = 140;
    form.height = 60;
    form.params = {};
    form.wheelAdapters = [];
  }

  function onPackageChange(metadata: ActivePackageMetadata | null) {
    packageSelection = metadata;
    if (!metadata) {
      form.params = {};
      return;
    }
    form.name = metadata.definition.name;
    form.color = metadata.definition.view.color;
    form.width = metadata.definition.view.width;
    form.height = metadata.definition.view.height;
    form.params = initialPackageParameters(metadata.definition);
    form.wheelAdapters = [];
  }

  function handleCreate() {
    const position = getSpawnPosition();
    if (packageSelection) {
      const definition = packageSelection.definition;
      diagram.addPackageNode(packageIdentity(packageSelection), definition.kind, position.x, position.y, {
        name: form.name,
        color: form.color,
        width: form.width,
        height: form.height,
        params: form.params,
        wheelAdapters: form.wheelAdapters,
        inputsCount: definition.kind === "join" ? 2 : undefined,
      });
      resetForm();
      return;
    }
    return;
    resetForm();
  }

  function handleManualUpdate() {
    if (!selectedNode) return;
    if (isPackageNode && packageSelection) {
      diagram.updatePackageNode(selectedNode.id, packageIdentity(packageSelection), packageSelection.definition.kind, {
        name: form.name,
        color: form.color,
        width: form.width,
        height: form.height,
        params: form.params,
        wheelAdapters: form.wheelAdapters,
        inputsCount: Number(selectedNode.data.inputsCount ?? 2),
      });
      // Keep the selected-node panel in sync even when Svelte has not yet
      // propagated the replaced $state.raw node array to this component.
      diagram.refreshTypes();
      return;
    }
    throw new Error("Legacy node cannot be updated");
  }

  function updatePackageParameter(name: string, definition: ParameterDefinition, raw: unknown) {
    let value: unknown = raw;
    if (definition.type === "integer") value = Number(raw);
    else if (definition.type === "number") value = Number(raw);
    else if (definition.type === "boolean") value = Boolean(raw);
    else if (definition.type === "shape" || definition.type === "list") value = parseShapeOrList(String(raw));
    if ((definition.type === "shape" || definition.type === "list") && value === undefined) return;
    form.params = { ...form.params, [name]: value };
    handleManualUpdate();
  }

  function updateReference(name: string, metadata: ActivePackageMetadata | null) {
    if (!metadata || !packageSelection) return;
    form.params = {
      ...form.params,
      [name]: {
        id: metadata.id,
        version: metadata.version,
        parameters: initialPackageParameters(metadata.definition),
      },
    };
    handleManualUpdate();
  }

  function referenceMetadata(value: unknown): ActivePackageMetadata | null {
    if (!value || typeof value !== "object") return null;
    const reference = value as { id?: unknown; version?: unknown };
    return diagram.packageCatalog.find((metadata) => packageReferenceMatches(metadata, reference)) ?? null;
  }

  function updateReferenceParameter(parent: string, child: string, definition: ParameterDefinition, raw: unknown) {
    const current = form.params[parent];
    if (!current || typeof current !== "object") return;
    const reference = current as { id: string; version: string; parameters: Record<string, unknown> };
    let value: unknown = raw;
    if (definition.type === "integer" || definition.type === "number") value = Number(raw);
    if (definition.type === "boolean") value = Boolean(raw);
    form.params = {
      ...form.params,
      [parent]: { ...reference, parameters: { ...reference.parameters, [child]: value } },
    };
    handleManualUpdate();
  }

  function getNodeLabel(nodeId: string): string {
    const node = diagram.nodes.find((candidate) => candidate.id === nodeId);
    const data = node?.data as Record<string, unknown> | undefined;
    const pkg = data?.package as { name?: unknown } | undefined;
    return String(data?.name ?? pkg?.name ?? nodeId);
  }

  function selectDiagnosticNode(nodeId: string) {
    diagram.selectNodes([nodeId]);
  }

  type VisibleDiagnostic = {
    nodeId: string;
    severity: "unresolved" | "error" | "fault";
    title: string;
    message: string;
  };

  let packageDiagnostics = $derived.by(() => {
    const result = diagram.typeResult;
    if (!result) return [] as VisibleDiagnostic[];
    const nodes = isPackageNode && selectedNode ? [selectedNode] : diagram.nodes.filter((node) => nodePackageIdentity(node));
    const diagnostics: VisibleDiagnostic[] = [];
    for (const node of nodes) {
      const state = result.nodes.get(node.id);
      if (!state || state.status === "success") continue;
      if (state.status === "fault") diagnostics.push({
        nodeId: node.id, severity: "fault", title: "Runtime fault", message: state.fault.message,
      });
      else if (state.status === "error") diagnostics.push({
        nodeId: node.id, severity: "error", title: "Type error", message: state.message,
      });
      else diagnostics.push({
        nodeId: node.id,
        severity: "unresolved",
        title: "Incomplete",
        message: "reason" in state ? state.reason : `Missing: ${state.missingParameters.join(", ")}`,
      });
    }
    return diagnostics;
  });

  let diagnosticCount = $derived(packageDiagnostics.length);

  function packageStateMessage(state: EditorInferenceState | GraphNodeResult | undefined): string {
    if (!state) return "Package type-system is initializing.";
    if (state.status === "fault") return `Runtime fault: ${state.fault.message}`;
    if (state.status === "error") return state.message;
    if (state.status === "unresolved") return "reason" in state
      ? `Unresolved: ${state.reason}`
      : `Unresolved: ${state.missingParameters.join(", ")}`;
    return "";
  }
</script>

{#if isOpen}
  <aside class="sidebar" style={`width: ${sidebarWidth}px; user-select: ${isDragging ? "none" : "auto"};`}>
    <div class="resizer" onmousedown={startResize} role="separator" aria-orientation="vertical" tabindex="0"></div>
    <div class="sidebar-header">
      <h3>{!isEditing ? "Nuovo Nodo" : isPackageNode ? "Modifica Package" : selectedNode?.type === "subflow" ? "Modifica Subflow" : "Modifica Nodo"}</h3>
      <button class="close-btn" onclick={onClose}>✖</button>
    </div>

    <div class="form-container">
      <label>{selectedNode?.type === "subflow" ? "Etichetta Sottografo" : "Nome"}
        <input type="text" bind:value={form.name} oninput={handleManualUpdate} />
      </label>

      <div class="row">
        <label>Colore <input type="color" bind:value={form.color} oninput={handleManualUpdate} /></label>
        <label>Width <input type="number" bind:value={form.width} oninput={handleManualUpdate} /></label>
        <label>Height <input type="number" bind:value={form.height} oninput={handleManualUpdate} /></label>
      </div>

      {#if !isEditing || isPackageNode}
        <div>
          <label>Package</label>
          <SDropdown {diagram} packageCatalog={diagram.packageCatalog} selectedPackage={packageSelection} onPackageChange={onPackageChange} />
        </div>
      {/if}

      {#if packageSelection}
        <div class="package-kind">Kind: {packageSelection.definition.kind}</div>
        <div class="params-section">
          <h4>Parametri</h4>
          {#each packageParameters as [key, config] (key)}
            {@const current = parameterValue(form.params, key, config)}
            <div class="param-row">
              <label for={`package-param-${key}`}>{key}</label>
              {#if config.type === "dtype" || (config.type === "string" && config.choices)}
                <select id={`package-param-${key}`} value={formatEditorValue(current, config.type)} onchange={(event) => updatePackageParameter(key, config, (event.target as HTMLSelectElement).value)}>
                  {#each config.choices ?? [] as choice (choice)}<option value={choice}>{choice}</option>{/each}
                </select>
              {:else if config.type === "boolean"}
                <input id={`package-param-${key}`} type="checkbox" checked={Boolean(current)} onchange={(event) => updatePackageParameter(key, config, (event.target as HTMLInputElement).checked)} />
              {:else if config.type === "stereotype"}
                <select id={`package-param-${key}`} value={referenceMetadata(current) ? `${referenceMetadata(current)?.id}@${referenceMetadata(current)?.version}` : ""} onchange={(event) => updateReference(key, diagram.packageCatalog.find((metadata) => `${metadata.id}@${metadata.version}` === (event.target as HTMLSelectElement).value) ?? null)}>
                  <option value="">-- select {config.kind} --</option>
                  {#each diagram.packageCatalog.filter((metadata) => metadata.definition.kind === config.kind) as metadata (`${metadata.id}@${metadata.version}`)}
                    <option value={`${metadata.id}@${metadata.version}`}>{metadata.definition.name}</option>
                  {/each}
                </select>
                {@const nested = referenceMetadata(current)}
                {#if nested && current && typeof current === "object" && "parameters" in current}
                  <div class="nested-params">
                    {#each Object.entries(nested.definition.parameters) as [childKey, childConfig] (childKey)}
                      {@const childValue = parameterValue((current as { parameters: Record<string, unknown> }).parameters, childKey, childConfig)}
                      <label for={`package-param-${key}-${childKey}`}>{childKey}
                        {#if childConfig.type === "integer" || childConfig.type === "number"}
                          <input id={`package-param-${key}-${childKey}`} type="number" value={formatEditorValue(childValue, childConfig.type)} onchange={(event) => updateReferenceParameter(key, childKey, childConfig, (event.target as HTMLInputElement).value)} />
                        {:else}
                          <input id={`package-param-${key}-${childKey}`} type="text" value={formatEditorValue(childValue, childConfig.type)} onchange={(event) => updateReferenceParameter(key, childKey, childConfig, (event.target as HTMLInputElement).value)} />
                        {/if}
                      </label>
                    {/each}
                  </div>
                {/if}
              {:else}
                <input id={`package-param-${key}`} type={config.type === "integer" || config.type === "number" ? "number" : "text"} value={formatEditorValue(current, config.type)} min={config.type === "integer" || config.type === "number" ? config.minimum : undefined} max={config.type === "integer" || config.type === "number" ? config.maximum : undefined} onchange={(event) => updatePackageParameter(key, config, (event.target as HTMLInputElement).value)} />
              {/if}
            </div>
          {/each}
        </div>
        {#if packageAdapters.length > 0}
          <div class="params-section">
            <h4>Wheel adapters</h4>
            {#each packageAdapters as adapter (adapter.name)}
              <label class="adapter-option">
                <input
                  type="checkbox"
                  checked={form.wheelAdapters.includes(adapter.name)}
                  onchange={(event) => {
                    const enabled = (event.target as HTMLInputElement).checked;
                    form.wheelAdapters = enabled
                      ? [...new Set([...form.wheelAdapters, adapter.name])]
                      : form.wheelAdapters.filter((name) => name !== adapter.name);
                    if (isEditing) handleManualUpdate();
                  }}
                />
                {adapter.name}
              </label>
            {/each}
          </div>
        {/if}
      {/if}

      {#if !isEditing && packageSelection}
        <button class="create-btn" onclick={handleCreate}>➕ Aggiungi al Canvas</button>
      {:else if isEditing}
        <button class="update-btn" onclick={handleManualUpdate}>💾 Salva Modifiche</button>
      {/if}

      {#if isPackageNode}
        <div class="package-type-summary">
          <h4>Package Type</h4>
          {#if packageOutput}<div class="type-success">Output: {packageOutput}</div>{/if}
          {#if packageState && packageState.status !== "success"}<div class="type-error-msg">{packageStateMessage(packageState)}</div>{/if}
        </div>
      {/if}

      <section class="type-error-panel" aria-labelledby="type-check-heading">
        <div class="type-error-panel-header" id="type-check-heading">
          <span>Type Check</span>
          <span class:has-issues={diagnosticCount > 0} class="diagnostic-count">{diagnosticCount}</span>
        </div>
        {#if diagnosticCount === 0}
          <div class="type-errors-empty">No type issues.</div>
        {:else}
          {#each packageDiagnostics as diagnostic (`${diagnostic.nodeId}-${diagnostic.message}`)}
            <div class="type-error-item {diagnostic.severity}" role="button" tabindex="0" onclick={() => selectDiagnosticNode(diagnostic.nodeId)} onkeydown={(event) => { if (event.key === "Enter") selectDiagnosticNode(diagnostic.nodeId); }}>
              <span class="type-error-icon" aria-hidden="true">{diagnostic.severity === "fault" ? "⚡" : diagnostic.severity === "error" ? "×" : "!"}</span>
              <div class="type-error-text">
                <div class="type-error-heading"><span class="type-error-node">{getNodeLabel(diagnostic.nodeId)}</span><span class="type-error-kind">{diagnostic.title}</span></div>
                <span class="type-error-msg">{diagnostic.message}</span>
              </div>
            </div>
          {/each}
        {/if}
      </section>
    </div>
  </aside>
{/if}

<style>
  @import "../styles/sidebar.css";
  .type-error-panel { margin-top: 16px; border-top: 1px solid #e5e7eb; padding-top: 12px; }
  .type-error-panel-header { display: flex; justify-content: space-between; align-items: center; font-weight: 650; font-size: .85rem; margin-bottom: 8px; }
  .diagnostic-count { min-width: 22px; height: 20px; padding: 0 6px; border-radius: 999px; display: inline-grid; place-items: center; background: #e5e7eb; color: #4b5563; font-size: .72rem; }
  .diagnostic-count.has-issues { background: #fef3c7; color: #92400e; }
  .type-errors-empty { color: #6b7280; font-size: .8rem; }
  .type-error-item { display: flex; align-items: flex-start; gap: 9px; padding: 9px; margin-top: 6px; cursor: pointer; font-size: .8rem; border: 1px solid; border-radius: 6px; }
  .type-error-item:hover { filter: brightness(.98); }
  .type-error-item.unresolved { background: #fffbeb; border-color: #fde68a; color: #92400e; }
  .type-error-item.error { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
  .type-error-item.fault { background: #fff7ed; border-color: #fdba74; color: #9a3412; }
  .type-error-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .type-error-heading { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .type-error-node { font-weight: 700; color: #1f2937; }
  .type-error-kind { font-size: .68rem; font-weight: 650; letter-spacing: .02em; text-transform: uppercase; opacity: .78; }
  .type-error-msg { color: inherit; font-size: .78rem; line-height: 1.35; overflow-wrap: anywhere; white-space: pre-wrap; }
  .type-error-icon { flex: 0 0 20px; width: 20px; height: 20px; border: 1px solid currentColor; border-radius: 50%; display: inline-grid; place-items: center; font-weight: 800; line-height: 1; }
  .apply-suggestion-btn { align-self: flex-start; margin-top: 4px; padding: 3px 8px; border: 1px solid #2563eb; border-radius: 4px; background: #eff6ff; color: #1d4ed8; cursor: pointer; }
  .package-kind { color: #6b7280; font-size: .8rem; margin-top: -8px; }
  .package-type-summary { border-top: 1px solid #e5e7eb; padding-top: 8px; }
  .package-type-summary h4 { margin: 0 0 4px; font-size: .85rem; }
  .type-success { color: #166534; font-size: .82rem; }
  .type-error-msg { color: #b91c1c; font-size: .82rem; white-space: pre-wrap; }
  .nested-params { margin: 6px 0 0 10px; padding-left: 8px; border-left: 2px solid #d1d5db; display: flex; flex-direction: column; gap: 6px; }
  .adapter-option { flex-direction: row; align-items: center; gap: 6px; }
</style>
