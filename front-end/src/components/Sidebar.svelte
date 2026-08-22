<!--
NNModelling — DSL for designing neural networks via visual node editor
Copyright (C) 2026  Luca Sforza

Licensed under the GNU General Public License v3 or later.
-->

<script lang="ts">
  import SDropdown from "./SDropdown.svelte";
  import type { Diagram } from "../Diagram.svelte";
  import type { StereotypeCore } from "../core/StereotypeCore";
  import type { Node } from "@xyflow/svelte";
  import type { TypeSuggestion } from "../conversion/tensortypes";
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
  });
  let legacySelection = $state<StereotypeCore | null>(null);
  let packageSelection = $state<ActivePackageMetadata | null>(null);
  let sidebarWidth = $state(320);
  let isDragging = $state(false);
  let lastLoadedKey = $state<string | null>(null);

  let isEditing = $derived(selectedNode !== null);
  let selectedPackageIdentity = $derived(selectedNode ? nodePackageIdentity(selectedNode) : undefined);
  let isPackageNode = $derived(selectedPackageIdentity !== undefined);
  let packageDefinition = $derived(packageSelection?.definition ?? null);
  let packageParameters = $derived(packageDefinition ? Object.entries(packageDefinition.parameters) : []);
  let packageOutput = $derived(selectedNode && isPackageNode
    ? packageOutputLabel(diagram.packageTypeResult, selectedNode.id)
    : null);
  let packageState = $derived(selectedNode && isPackageNode
    ? diagram.packageTypeResult?.nodes.get(selectedNode.id)
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
      legacySelection = null;
      form.name = String(node.data.name ?? node.data.label ?? packageSelection?.definition.name ?? "");
      form.color = String(node.data.color ?? packageSelection?.definition.view.color ?? "#4779c4");
      form.width = node.width ?? packageSelection?.definition.view.width ?? 140;
      form.height = node.height ?? packageSelection?.definition.view.height ?? 60;
      form.params = packageSelection
        ? initialPackageParameters(packageSelection.definition, (node.data.params as Record<string, unknown> | undefined))
        : structuredClone((node.data.params as Record<string, unknown> | undefined) ?? {});
      return;
    }

    packageSelection = null;
    const stereotypeName = String(node.data.stereotype ?? "");
    legacySelection = diagram.stereotypes.find((stereotype) => stereotype.name === stereotypeName) ?? null;
    form.name = String(node.data.name ?? node.data.label ?? "");
    form.color = String(node.data.color ?? (node.type === "subflow" ? "#9b59b6" : "#4779c4"));
    form.width = node.width ?? (node.type === "subflow" ? 400 : 140);
    form.height = node.height ?? (node.type === "subflow" ? 300 : 60);
    const params = (node.data.params as Record<string, { value?: unknown; position?: string } | unknown> | undefined) ?? {};
    form.params = Object.fromEntries(Object.entries(params).map(([key, value]) => [
      key,
      value && typeof value === "object" && "value" in value ? (value as { value: unknown }).value : value,
    ]));
  }

  function resetForm() {
    packageSelection = null;
    legacySelection = null;
    form.name = "";
    form.color = "#4779c4";
    form.width = 140;
    form.height = 60;
    form.params = {};
  }

  function onPackageChange(metadata: ActivePackageMetadata | null) {
    packageSelection = metadata;
    legacySelection = null;
    if (!metadata) {
      form.params = {};
      return;
    }
    form.name = metadata.definition.name;
    form.color = metadata.definition.view.color;
    form.width = metadata.definition.view.width;
    form.height = metadata.definition.view.height;
    form.params = initialPackageParameters(metadata.definition);
  }

  function onLegacyChange(stereotype: StereotypeCore | null) {
    legacySelection = stereotype;
    packageSelection = null;
    if (!stereotype) {
      form.params = {};
      return;
    }
    form.color = stereotype.view?.color ?? "#4779c4";
    form.width = stereotype.view?.width ?? 140;
    form.height = stereotype.view?.height ?? 60;
    form.params = Object.fromEntries(Object.entries(stereotype.parameters ?? {}).map(([key, definition]) => [key, definition.default]));
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
        inputsCount: definition.kind === "join" ? 2 : undefined,
      });
      resetForm();
      return;
    }
    if (!legacySelection) return;
    if (legacySelection.isJoin) {
      diagram.addJoinNode(legacySelection, position.x, position.y, { name: form.name, color: form.color, params: form.params });
    } else {
      diagram.addModule(legacySelection, position.x, position.y, {
        name: form.name,
        color: form.color,
        width: form.width,
        height: form.height,
        params: form.params,
      });
    }
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
        inputsCount: Number(selectedNode.data.inputsCount ?? 2),
      });
      // Keep the selected-node panel in sync even when Svelte has not yet
      // propagated the replaced $state.raw node array to this component.
      diagram.refreshTypes();
      return;
    }
    diagram.updateModule(selectedNode.id, {
      name: form.name,
      label: selectedNode.type === "subflow" ? form.name : undefined,
      color: form.color,
      width: form.width,
      height: form.height,
      stereotype: legacySelection?.name,
      params: Object.fromEntries(Object.entries(form.params).map(([key, value]) => [key, { value }])),
    });
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
    return String(node?.data.name ?? node?.data.stereotype ?? nodeId);
  }

  function selectDiagnosticNode(nodeId: string) {
    diagram.selectNodes([nodeId]);
  }

  function applySuggestion(suggestion: TypeSuggestion) {
    const target = diagram.getNodeById(suggestion.nodeId);
    if (!target || nodePackageIdentity(target)) return;
    const params = (target.data.params as Record<string, Record<string, unknown>>) ?? {};
    const existing = params[suggestion.param] ?? {};
    diagram.updateModule(suggestion.nodeId, { params: { ...params, [suggestion.param]: { ...existing, value: String(suggestion.value) } } });
  }

  let legacyDiagnostics = $derived.by(() => {
    const result = diagram.typeResult;
    if (!result || isPackageNode) return { errors: [], warnings: [], suggestions: [] };
    const packageIds = new Set(diagram.nodes.filter((node) => nodePackageIdentity(node)).map((node) => node.id));
    return {
      errors: result.errors.filter((item) => !packageIds.has(item.nodeId)),
      warnings: result.warnings.filter((item) => !packageIds.has(item.nodeId)),
      suggestions: result.suggestions.filter((item) => !packageIds.has(item.nodeId)),
    };
  });

  let packageDiagnostics = $derived.by(() => {
    const result = diagram.packageTypeResult;
    if (!result) return [] as Array<{ nodeId: string; severity: string; message: string }>;
    const nodes = isPackageNode && selectedNode ? [selectedNode] : diagram.nodes.filter((node) => nodePackageIdentity(node));
    return nodes.flatMap((node) => {
      const diagnostic = packageDiagnostic(result, node.id);
      return diagnostic ? [{ nodeId: node.id, severity: diagnostic.severity, message: diagnostic.message }] : [];
    });
  });

  let diagnosticCount = $derived(isPackageNode
    ? packageDiagnostics.length
    : legacyDiagnostics.errors.length + legacyDiagnostics.warnings.length + legacyDiagnostics.suggestions.length);

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
      {:else}
        <div>
          <label>Stereotipo legacy</label>
          <SDropdown {diagram} selectedStereotype={legacySelection} onSelectedChange={onLegacyChange} />
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
      {:else if legacySelection}
        <div class="params-section">
          <h4>Parametri legacy</h4>
          {#each Object.entries(legacySelection.parameters ?? {}) as [key, config] (key)}
            <div class="param-row"><label for={`legacy-param-${key}`}>{key}</label><input id={`legacy-param-${key}`} type="text" value={String(form.params[key] ?? config.default ?? "")} oninput={(event) => { form.params = { ...form.params, [key]: (event.target as HTMLInputElement).value }; handleManualUpdate(); }} /></div>
          {/each}
        </div>
      {/if}

      {#if !isEditing && (packageSelection || legacySelection)}
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

      <div class="type-error-panel">
        <div class="type-error-panel-header">Type Check ({diagnosticCount} issues)</div>
        {#if diagnosticCount === 0}<div class="type-errors-empty">No type errors or warnings.</div>{/if}
        {#if isPackageNode}
          {#each packageDiagnostics as diagnostic (`${diagnostic.nodeId}-${diagnostic.message}`)}
            <div class="type-error-item {diagnostic.severity}" role="button" tabindex="0" onclick={() => selectDiagnosticNode(diagnostic.nodeId)} onkeydown={(event) => { if (event.key === "Enter") selectDiagnosticNode(diagnostic.nodeId); }}>
              <span class="type-error-icon">{diagnostic.severity === "error" ? "❌" : "⚠️"}</span><div class="type-error-text"><span class="type-error-node">{getNodeLabel(diagnostic.nodeId)}</span><span class="type-error-msg">{diagnostic.message}</span></div>
            </div>
          {/each}
        {:else}
          {#each legacyDiagnostics.errors as error (error.nodeId)}
            <div class="type-error-item error" role="button" tabindex="0" onclick={() => selectDiagnosticNode(error.nodeId)}><span class="type-error-icon">❌</span><div class="type-error-text"><span class="type-error-node">{getNodeLabel(error.nodeId)}</span><span class="type-error-msg">{error.message}</span></div></div>
          {/each}
          {#each legacyDiagnostics.warnings as warning (`${warning.nodeId}-${warning.kind}`)}
            <div class="type-error-item warning" role="button" tabindex="0" onclick={() => selectDiagnosticNode(warning.nodeId)}><span class="type-error-icon">⚠️</span><div class="type-error-text"><span class="type-error-node">{getNodeLabel(warning.nodeId)} · {warning.kind}</span><span class="type-error-msg">{warning.message}</span></div></div>
          {/each}
          {#each legacyDiagnostics.suggestions as suggestion (`${suggestion.nodeId}-${suggestion.param}`)}
            <div class="type-error-item suggestion" role="button" tabindex="0" onclick={() => selectDiagnosticNode(suggestion.nodeId)}><span class="type-error-icon">💡</span><div class="type-error-text"><span class="type-error-node">{getNodeLabel(suggestion.nodeId)} · {suggestion.param}</span><span class="type-error-msg">Set to {suggestion.value}: {suggestion.reason}</span><button class="apply-suggestion-btn" onclick={(event) => { event.stopPropagation(); applySuggestion(suggestion); }}>Applica</button></div></div>
          {/each}
        {/if}
      </div>
    </div>
  </aside>
{/if}

<style>
  @import "../styles/sidebar.css";
  .type-error-panel { margin-top: 16px; border-top: 1px solid #e5e7eb; padding: 8px; }
  .type-error-panel-header { font-weight: 600; font-size: .85rem; margin-bottom: 6px; }
  .type-errors-empty { font-style: italic; color: #6b7280; font-size: .8rem; }
  .type-error-item { display: flex; align-items: flex-start; gap: 6px; padding: 3px 0; cursor: pointer; font-size: .8rem; }
  .type-error-item:hover { background: #f3f4f6; }
  .type-error-item.error .type-error-msg { color: #dc2626; }
  .type-error-item.warning .type-error-msg { color: #f59e0b; }
  .type-error-item.suggestion .type-error-msg { color: #2563eb; }
  .type-error-text { display: flex; flex-direction: column; }
  .type-error-node { font-weight: 600; }
  .type-error-icon { flex-shrink: 0; }
  .apply-suggestion-btn { align-self: flex-start; margin-top: 4px; padding: 3px 8px; border: 1px solid #2563eb; border-radius: 4px; background: #eff6ff; color: #1d4ed8; cursor: pointer; }
  .package-kind { color: #6b7280; font-size: .8rem; margin-top: -8px; }
  .package-type-summary { border-top: 1px solid #e5e7eb; padding-top: 8px; }
  .package-type-summary h4 { margin: 0 0 4px; font-size: .85rem; }
  .type-success { color: #166534; font-size: .82rem; }
  .type-error-msg { color: #b91c1c; font-size: .82rem; white-space: pre-wrap; }
  .nested-params { margin: 6px 0 0 10px; padding-left: 8px; border-left: 2px solid #d1d5db; display: flex; flex-direction: column; gap: 6px; }
</style>
