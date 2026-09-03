<script lang="ts">
  import {
    datasetDataFileFeedback,
    readDatasetDataFile,
    validateDatasetAuthoringRequest,
    type DatasetAuthoringRequest,
    type DatasetDataFile,
    type DatasetSlotRequest,
  } from "../project-workspace/dataset-authoring";
  import type { DatasetDefinition, DatasetReference } from "../project-workspace/dataset-contract";
  import type { DType, Dimension } from "../type-system/tensor-type";

  interface Props {
    readonly projectDatasets?: readonly (DatasetReference & { readonly name?: string })[];
    readonly projectDefinitions?: readonly DatasetDefinition[];
    readonly onAuthoringRequest?: (request: DatasetAuthoringRequest) => Promise<void> | void;
  }

  let { projectDatasets = [], projectDefinitions = [], onAuthoringRequest }: Props = $props();
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

  function projectDatasetName(dataset: DatasetReference & { readonly name?: string }): string {
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
    const descriptionValue = typeof description === "string" ? description : "";
    const classCountValue = typeof classCount === "string" ? classCount : "";
    const classNamesValue = typeof classNames === "string" ? classNames : "";
    const parsedParameters = parameters.map((row) => ({
      name: row.name,
      type: row.type,
      required: row.required,
      ...(row.required || !row.defaultValue.trim() ? {} : { default: row.type === "integer" ? Number(row.defaultValue) : row.type === "number" ? Number(row.defaultValue) : row.type === "boolean" ? row.defaultValue === "true" : row.defaultValue }),
    }));
    const makeSlots = (rows: readonly SlotRow[]): DatasetSlotRequest[] => rows.map((row) => ({ name: row.name, shape: shapeFromText(row.shape), dtype: row.dtype }));
    const count = classCountValue.trim() ? Number(classCountValue) : undefined;
    return {
      id, version, directory, name,
      ...(descriptionValue.trim() ? { description: descriptionValue } : {}),
      parameters: parsedParameters,
      inputs: makeSlots(inputs),
      targets: makeSlots(targets),
      ...(count === undefined ? {} : { classes: { count, ...(classNamesValue.trim() ? { names: classNamesValue.split(",").map((item) => item.trim()) } : {}) } }),
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

<form class="stereotype-form dataset-form" onsubmit={submit} aria-labelledby="dataset-form-title">
  <div class="dataset-form__catalog package-manager__group">
    <h3>Current project datasets</h3>
    {#if projectDatasets.length === 0}<p class="package-manager__empty">No project datasets yet.</p>{/if}
    {#each projectDatasets as dataset (`${dataset.id}@${dataset.version}`)}
      <div class="package-manager__row"><span><strong>{projectDatasetName(dataset)}</strong><small>{dataset.id}@{dataset.version}</small></span><em>Project</em></div>
    {/each}
  </div>
  <div class="stereotype-form__heading"><div><h3 id="dataset-form-title">Author dataset</h3><p>Generate a manifest, editable Python scaffold, and project-local data directory.</p></div></div>
  {#if error}<p class="package-manager__message package-manager__message--error" role="alert">{error}</p>{:else if success}<p class="package-manager__message" role="status">Dataset request submitted.</p>{/if}

  <fieldset disabled={submitting || readingFiles}><legend>Identity and metadata</legend><div class="stereotype-form__grid">
    <label>ID <input required bind:value={id} autocomplete="off" /></label>
    <label>Version <input required bind:value={version} autocomplete="off" /></label>
    <label class="stereotype-form__wide">Directory <input required bind:value={directory} autocomplete="off" aria-describedby="dataset-directory-help" /></label>
    <label class="stereotype-form__wide">Name <input required bind:value={name} /></label>
    <label class="stereotype-form__wide">Description <textarea bind:value={description} rows="2"></textarea></label>
  </div><small id="dataset-directory-help" class="stereotype-form__help">Normalized path under <code>datasets/</code>; generated source never reads outside it.</small></fieldset>

  <fieldset disabled={submitting || readingFiles}><legend>Parameters</legend>
    {#if parameters.length === 0}<p class="package-manager__empty">No configurable parameters.</p>{/if}
    {#each parameters as parameter, index (index)}<div class="dataset-form__row dataset-form__parameter-row">
      <input aria-label={`Parameter ${index + 1} name`} placeholder="name" value={parameter.name} oninput={(event) => updateParameter(index, { name: (event.target as HTMLInputElement).value })} />
      <select aria-label={`Parameter ${index + 1} type`} value={parameter.type} onchange={(event) => updateParameter(index, { type: (event.target as HTMLSelectElement).value as ParameterRow["type"] })}><option value="string">string</option><option value="integer">integer</option><option value="number">number</option><option value="boolean">boolean</option></select>
      <label class="parameter-row__checkbox"><input type="checkbox" checked={parameter.required} onchange={(event) => updateParameter(index, { required: (event.target as HTMLInputElement).checked })} /> required</label>
      <input aria-label={`Parameter ${index + 1} default`} placeholder="default" value={parameter.defaultValue} oninput={(event) => updateParameter(index, { defaultValue: (event.target as HTMLInputElement).value })} />
      <button type="button" class="dataset-form__remove" onclick={() => removeParameter(index)} aria-label={`Remove parameter ${parameter.name}`}>×</button>
    </div>{/each}
    <button type="button" class="parameter-form__add" onclick={addParameter}>+ Add parameter</button>
  </fieldset>

  {#each [{ kind: "input", title: "Named input slots", rows: inputs }, { kind: "target", title: "Named target slots", rows: targets }] as group (group.kind)}
    <fieldset disabled={submitting || readingFiles}><legend>{group.title}</legend>
      {#each group.rows as slot, index (index)}<div class="dataset-form__row dataset-form__slot-row">
        <input aria-label={`${group.kind} slot ${index + 1} name`} placeholder="slot name" value={slot.name} oninput={(event) => updateSlot(group.kind as "input" | "target", index, { name: (event.target as HTMLInputElement).value })} />
        <input aria-label={`${group.kind} slot ${index + 1} shape`} placeholder="B, T" value={slot.shape} oninput={(event) => updateSlot(group.kind as "input" | "target", index, { shape: (event.target as HTMLInputElement).value })} />
        <select aria-label={`${group.kind} slot ${index + 1} dtype`} value={slot.dtype} onchange={(event) => updateSlot(group.kind as "input" | "target", index, { dtype: (event.target as HTMLSelectElement).value as DType })}>{#each dtypes as dtype}<option value={dtype}>{dtype}</option>{/each}</select>
        <button type="button" class="dataset-form__remove" onclick={() => removeSlot(group.kind as "input" | "target", index)} aria-label={`Remove ${group.kind} slot ${slot.name}`}>×</button>
      </div>{/each}
      <button type="button" class="parameter-form__add" onclick={() => addSlot(group.kind as "input" | "target")}>+ Add slot</button>
    </fieldset>
  {/each}

  <fieldset disabled={submitting || readingFiles}><legend>Classes and local data</legend>
    <div class="stereotype-form__grid"><label>Class count <input type="number" min="1" step="1" bind:value={classCount} /></label><label>Class names <input bind:value={classNames} placeholder="cat, dog" /></label></div>
    <label class="dataset-form__file-picker">Add files under <code>data/</code><input type="file" multiple onchange={handleFileSelection} /></label>
    {#if readingFiles}<p class="package-manager__empty">Reading selected files…</p>{/if}
    {#each fileFeedback as file (file.path)}<div class="dataset-form__file-row"><span>{file.path}</span><small>{file.size.toLocaleString()} bytes · {file.totalSize.toLocaleString()} bytes total</small></div>{/each}
    <small class="stereotype-form__help">Files are copied into the dataset directory. Symlinks and external paths are not accepted.</small>
  </fieldset>
  <button class="stereotype-form__submit" type="submit" disabled={submitting || readingFiles} aria-busy={submitting}>{submitting ? "Creating…" : "Create project dataset"}</button>
</form>
