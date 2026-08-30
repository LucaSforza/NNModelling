<script lang="ts">
  import {
    datasetDataFileFeedback,
    readDatasetDataFile,
    validateDatasetAuthoringRequest,
    type DatasetAuthoringRequest,
    type DatasetDataFile,
    type DatasetSlotRequest,
  } from "../project-workspace/dataset-authoring";
  import type { DatasetDefinition, ModelDatasetReference } from "../project-workspace/dataset-contract";
  import type { DType, Dimension } from "../type-system/tensor-type";

  export type DatasetCatalogEntry = {
    readonly id: string;
    readonly version: string;
    readonly name: string;
    readonly description?: string;
    readonly kind: "builtin" | "project";
  };

  interface Props {
    readonly builtins?: readonly DatasetCatalogEntry[];
    readonly projectDatasets?: readonly (ModelDatasetReference & { readonly name?: string })[];
    readonly projectDefinitions?: readonly DatasetDefinition[];
    readonly onAuthoringRequest?: (request: DatasetAuthoringRequest) => Promise<void> | void;
  }

  let { builtins = [], projectDatasets = [], projectDefinitions = [], onAuthoringRequest }: Props = $props();
  let id = $state("project.dataset");
  let version = $state("1.0.0");
  let directory = $state("datasets/project-dataset");
  let name = $state("Project dataset");
  let description = $state("");
  let parameters = $state<ParameterRow[]>([]);
  let inputs = $state<SlotRow[]>([{ name: "features", shape: "B", dtype: "float32" }]);
  let targets = $state<SlotRow[]>([{ name: "labels", shape: "B", dtype: "int64" }]);
  let classCount = $state("");
  let classNames = $state("");
  let files = $state<DatasetDataFile[]>([]);
  let submitting = $state(false);
  let readingFiles = $state(false);
  let error = $state<string | null>(null);
  let success = $state(false);

  type ParameterRow = { name: string; type: "string" | "integer" | "number" | "boolean"; required: boolean; defaultValue: string };
  type SlotRow = { name: string; shape: string; dtype: DType };
  const dtypes: DType[] = ["float16", "bfloat16", "float32", "float64", "int8", "uint8", "int16", "int32", "int64", "bool"];

  let fileFeedback = $derived(datasetDataFileFeedback(files));

  function addParameter() { parameters = [...parameters, { name: "parameter", type: "string", required: false, defaultValue: "" }]; }
  function removeParameter(index: number) { parameters = parameters.filter((_, rowIndex) => rowIndex !== index); }
  function addSlot(kind: "input" | "target") {
    const next: SlotRow = { name: kind === "input" ? "input" : "target", shape: "B", dtype: kind === "input" ? "float32" : "int64" };
    if (kind === "input") inputs = [...inputs, next]; else targets = [...targets, next];
  }
  function removeSlot(kind: "input" | "target", index: number) {
    if (kind === "input") inputs = inputs.filter((_, rowIndex) => rowIndex !== index);
    else targets = targets.filter((_, rowIndex) => rowIndex !== index);
  }
  function updateParameter(index: number, patch: Partial<ParameterRow>) {
    parameters = parameters.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row);
  }
  function updateSlot(kind: "input" | "target", index: number, patch: Partial<SlotRow>) {
    const rows = kind === "input" ? inputs : targets;
    const next = rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row);
    if (kind === "input") inputs = next; else targets = next;
  }

  function shapeFromText(value: string): Dimension[] {
    return value.split(",").map((item) => item.trim()).filter(Boolean).map((item) => /^\d+$/.test(item) ? Number(item) : item);
  }

  function projectDatasetName(dataset: ModelDatasetReference & { readonly name?: string }): string {
    return dataset.name ?? projectDefinitions.find((definition) => definition.id === dataset.id && definition.version === dataset.version)?.name ?? dataset.id;
  }

  async function handleFileSelection(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files) return;
    readingFiles = true;
    error = null;
    try {
      const next = await Promise.all(Array.from(input.files).map((file) => readDatasetDataFile(file)));
      const byPath = new Map(files.map((file) => [file.path, file]));
      for (const file of next) byPath.set(file.path, file);
      files = [...byPath.values()];
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      readingFiles = false;
      input.value = "";
    }
  }

  function requestFromForm(): DatasetAuthoringRequest {
    const parsedParameters = parameters.map((row) => ({
      name: row.name,
      type: row.type,
      required: row.required,
      ...(row.required || !row.defaultValue.trim() ? {} : { default: row.type === "integer" ? Number(row.defaultValue) : row.type === "number" ? Number(row.defaultValue) : row.type === "boolean" ? row.defaultValue === "true" : row.defaultValue }),
    }));
    const makeSlots = (rows: readonly SlotRow[]): DatasetSlotRequest[] => rows.map((row) => ({ name: row.name, shape: shapeFromText(row.shape), dtype: row.dtype }));
    const count = classCount.trim() ? Number(classCount) : undefined;
    return {
      id, version, directory, name,
      ...(description.trim() ? { description } : {}),
      parameters: parsedParameters,
      inputs: makeSlots(inputs),
      targets: makeSlots(targets),
      ...(count === undefined ? {} : { classes: { count, ...(classNames.trim() ? { names: classNames.split(",").map((item) => item.trim()) } : {}) } }),
      dataFiles: files,
    };
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (submitting || readingFiles) return;
    submitting = true;
    error = null;
    success = false;
    try {
      const request = validateDatasetAuthoringRequest(requestFromForm());
      if (onAuthoringRequest) await onAuthoringRequest(request);
      success = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      submitting = false;
    }
  }
</script>

<section class="dataset-manager" aria-label="Dataset manager">
  <header class="dataset-manager__header">
    <div><h2>Datasets</h2><p>Built-ins are read-only. Author a dataset owned by the current project.</p></div>
  </header>

  <div class="dataset-manager__catalog">
    <div><h3>Built-in</h3>{#if builtins.length === 0}<p class="empty">No built-in datasets.</p>{/if}</div>
    {#each builtins as dataset (`${dataset.id}@${dataset.version}`)}
      <div class="catalog-row"><span><strong>{dataset.name}</strong><small>{dataset.id}@{dataset.version}</small></span><em>Read-only</em></div>
    {/each}
    <div><h3>Current project</h3>{#if projectDatasets.length === 0}<p class="empty">No project datasets yet.</p>{/if}</div>
    {#each projectDatasets as dataset (`${dataset.id}@${dataset.version}`)}
      <div class="catalog-row"><span><strong>{projectDatasetName(dataset)}</strong><small>{dataset.id}@{dataset.version}</small></span><em>Project</em></div>
    {/each}
  </div>

  <form onsubmit={submit} aria-labelledby="dataset-form-title">
    <div class="form-heading"><h3 id="dataset-form-title">Author dataset</h3><p>Generate a manifest, editable Python scaffold, and project-local data directory.</p></div>
    {#if error}<p class="message error" role="alert">{error}</p>{:else if success}<p class="message" role="status">Dataset request submitted.</p>{/if}

    <fieldset disabled={submitting || readingFiles}><legend>Identity and metadata</legend><div class="grid">
      <label>ID <input required bind:value={id} autocomplete="off" /></label>
      <label>Version <input required bind:value={version} autocomplete="off" /></label>
      <label class="wide">Directory <input required bind:value={directory} autocomplete="off" aria-describedby="dataset-directory-help" /></label>
      <label class="wide">Name <input required bind:value={name} /></label>
      <label class="wide">Description <textarea bind:value={description} rows="2"></textarea></label>
    </div><small id="dataset-directory-help">Normalized path under <code>datasets/</code>; generated source never reads outside it.</small></fieldset>

    <fieldset disabled={submitting || readingFiles}><legend>Parameters</legend>
      {#if parameters.length === 0}<p class="empty">No configurable parameters.</p>{/if}
      {#each parameters as parameter, index (index)}<div class="row parameter-row">
        <input aria-label={`Parameter ${index + 1} name`} placeholder="name" value={parameter.name} oninput={(event) => updateParameter(index, { name: (event.target as HTMLInputElement).value })} />
        <select aria-label={`Parameter ${index + 1} type`} value={parameter.type} onchange={(event) => updateParameter(index, { type: (event.target as HTMLSelectElement).value as ParameterRow["type"] })}><option value="string">string</option><option value="integer">integer</option><option value="number">number</option><option value="boolean">boolean</option></select>
        <label class="check"><input type="checkbox" checked={parameter.required} onchange={(event) => updateParameter(index, { required: (event.target as HTMLInputElement).checked })} /> required</label>
        <input aria-label={`Parameter ${index + 1} default`} placeholder="default" value={parameter.defaultValue} oninput={(event) => updateParameter(index, { defaultValue: (event.target as HTMLInputElement).value })} />
        <button type="button" class="remove" onclick={() => removeParameter(index)} aria-label={`Remove parameter ${parameter.name}`}>×</button>
      </div>{/each}
      <button type="button" class="secondary" onclick={addParameter}>+ Add parameter</button>
    </fieldset>

    {#each [{ kind: "input", title: "Named input slots", rows: inputs }, { kind: "target", title: "Named target slots", rows: targets }] as group (group.kind)}
      <fieldset disabled={submitting || readingFiles}><legend>{group.title}</legend>
        {#each group.rows as slot, index (index)}<div class="row slot-row">
          <input aria-label={`${group.kind} slot ${index + 1} name`} placeholder="slot name" value={slot.name} oninput={(event) => updateSlot(group.kind as "input" | "target", index, { name: (event.target as HTMLInputElement).value })} />
          <input aria-label={`${group.kind} slot ${index + 1} shape`} placeholder="B, T" value={slot.shape} oninput={(event) => updateSlot(group.kind as "input" | "target", index, { shape: (event.target as HTMLInputElement).value })} />
          <select aria-label={`${group.kind} slot ${index + 1} dtype`} value={slot.dtype} onchange={(event) => updateSlot(group.kind as "input" | "target", index, { dtype: (event.target as HTMLSelectElement).value as DType })}>{#each dtypes as dtype}<option value={dtype}>{dtype}</option>{/each}</select>
          <button type="button" class="remove" onclick={() => removeSlot(group.kind as "input" | "target", index)} aria-label={`Remove ${group.kind} slot ${slot.name}`}>×</button>
        </div>{/each}
        <button type="button" class="secondary" onclick={() => addSlot(group.kind as "input" | "target")}>+ Add slot</button>
      </fieldset>
    {/each}

    <fieldset disabled={submitting || readingFiles}><legend>Classes and local data</legend>
      <div class="grid"><label>Class count <input type="number" min="1" step="1" bind:value={classCount} /></label><label>Class names <input bind:value={classNames} placeholder="cat, dog" /></label></div>
      <label class="file-picker">Add files under <code>data/</code><input type="file" multiple onchange={handleFileSelection} /></label>
      {#if readingFiles}<p class="empty">Reading selected files…</p>{/if}
      {#each fileFeedback as file (file.path)}<div class="file-row"><span>{file.path}</span><small>{file.size.toLocaleString()} bytes · {file.totalSize.toLocaleString()} bytes total</small></div>{/each}
      <small>Files are copied into the dataset directory. Symlinks and external paths are not accepted.</small>
    </fieldset>
    <button class="submit" type="submit" disabled={submitting || readingFiles} aria-busy={submitting}>{submitting ? "Creating…" : "Create project dataset"}</button>
  </form>
</section>

<style>
  .dataset-manager { color: #20385d; font: 14px system-ui, sans-serif; }
  .dataset-manager__header, .form-heading { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
  h2, h3, p { margin: 0; }
  h2 { font-size: 1.35rem; } h3 { font-size: .95rem; } p { color: #718097; line-height: 1.45; }
  .dataset-manager__catalog { display: grid; gap: 7px; margin-bottom: 20px; }
  .catalog-row, .file-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid #dfe6ef; border-radius: 8px; padding: 8px 10px; background: #f8fafc; }
  .catalog-row span { display: grid; gap: 2px; } small { color: #718097; font-size: .76rem; } em { color: #4779c4; font-size: .75rem; font-style: normal; font-weight: 700; }
  form { display: grid; gap: 14px; } fieldset { display: grid; gap: 10px; border: 1px solid #dfe6ef; border-radius: 10px; padding: 12px; } legend { padding: 0 5px; font-weight: 700; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; } label { display: grid; gap: 5px; color: #40536e; font-size: .82rem; font-weight: 650; } label.wide { grid-column: 1 / -1; }
  input, select, textarea { box-sizing: border-box; width: 100%; border: 1px solid #cbd5e1; border-radius: 6px; padding: 7px 8px; color: #20385d; background: white; font: inherit; } textarea { resize: vertical; }
  .row { display: flex; align-items: center; gap: 7px; } .parameter-row input:first-child { flex: 1.2; } .parameter-row input { min-width: 0; flex: 1; } .parameter-row select { width: 105px; } .slot-row input { flex: 1; min-width: 0; } .slot-row select { width: 120px; }
  .check { display: flex; align-items: center; gap: 4px; white-space: nowrap; } .check input { width: auto; } button { cursor: pointer; border: 0; border-radius: 7px; padding: 8px 11px; font: inherit; font-weight: 700; } button.secondary { justify-self: start; color: #315f9c; background: #eaf2ff; } button.remove { padding: 2px 8px; color: #9a2626; background: #fff0f0; } button.submit { color: white; background: #315f9c; } button:disabled { cursor: wait; opacity: .55; }
  .file-picker { display: flex; grid-template-columns: auto; align-items: center; gap: 10px; } .file-picker input { width: auto; border: 0; padding: 0; } .file-row { padding: 6px 8px; font-size: .8rem; } .empty { color: #718097; font-size: .8rem; } code { border-radius: 4px; padding: 1px 4px; background: #edf2f7; font-size: .85em; } .message { border-radius: 7px; padding: 8px 10px; color: #2e6b3d; background: #eef9f0; } .message.error { color: #9a2626; background: #fff0f0; }
  @media (max-width: 620px) { .grid { grid-template-columns: 1fr; } label.wide { grid-column: auto; } .row { flex-wrap: wrap; } .parameter-row > *, .slot-row > * { flex: 1 1 120px; } }
</style>
