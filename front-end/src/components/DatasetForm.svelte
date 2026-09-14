<script lang="ts">
  import {
    datasetDataFileFeedback,
    readDatasetDataFile,
    validateDatasetAuthoringRequest,
    type DatasetAuthoringRequest,
    type DatasetDataFile,
    type DatasetSlotRequest,
  } from "../project-workspace/dataset-authoring";
  import type { GeneratedDatasetResources } from "../project-workspace/dataset-authoring";
  import type { ModelDatasetReference } from "../project-workspace/dataset-contract";
  import type { DType, Dimension } from "../type-system/tensor-type";
  import { useI18n } from "../i18n.svelte";

  interface Props {
    readonly projectDatasets?: readonly GeneratedDatasetResources[];
    readonly onAuthoringRequest?: (request: DatasetAuthoringRequest) => Promise<void> | void;
    readonly onUpdateRequest?: (target: ModelDatasetReference, request: DatasetAuthoringRequest) => Promise<void> | void;
    readonly onDeleteRequest?: (target: ModelDatasetReference) => Promise<void> | void;
  }

  let { projectDatasets = [], onAuthoringRequest, onUpdateRequest, onDeleteRequest }: Props = $props();
  const { t } = useI18n();
  let id = $state("project.dataset");
  let version = $state("1.0.0");
  let directory = $state("datasets/project-dataset");
  let name = $state("Project dataset");
  let description = $state("");
  let parameters = $state<ParameterRow[]>([]);
  let inputs = $state<SlotRow[]>([{ name: "features", shape: "B", dtype: "float32" }]);
  let targets = $state<SlotRow[]>([{ name: "labels", shape: "B", dtype: "int64" }]);
  // `bind:value` on a number input yields a number (or undefined when empty).
  // Keep both representations at the UI boundary and let the domain validator
  // reject malformed values instead of silently dropping the classes metadata.
  let classCount = $state<string | number | undefined>("");
  let classNames = $state("");
  let files = $state<DatasetDataFile[]>([]);
  let submitting = $state(false);
  let readingFiles = $state(false);
  let error = $state<string | null>(null);
  let success = $state(false);
  let selectedDataset = $state<GeneratedDatasetResources | null>(null);
  let pendingDeletion = $state<GeneratedDatasetResources | null>(null);
  let deleting = $state(false);

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

  let isEditing = $derived(selectedDataset !== null);

  function resetForm(): void {
    selectedDataset = null;
    pendingDeletion = null;
    id = "project.dataset";
    version = "1.0.0";
    directory = "datasets/project-dataset";
    name = "Project dataset";
    description = "";
    parameters = [];
    inputs = [{ name: "features", shape: "B", dtype: "float32" }];
    targets = [{ name: "labels", shape: "B", dtype: "int64" }];
    classCount = "";
    classNames = "";
    files = [];
    error = null;
    success = false;
  }

  function editDataset(dataset: GeneratedDatasetResources): void {
    selectedDataset = dataset;
    pendingDeletion = null;
    id = dataset.modelDataset.id;
    version = dataset.modelDataset.version;
    directory = dataset.modelDataset.path;
    name = dataset.definition.name;
    description = dataset.definition.description ?? "";
    parameters = dataset.definition.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      required: parameter.required,
      defaultValue: parameter.default === undefined ? "" : String(parameter.default),
    }));
    inputs = Object.entries(dataset.definition.batch.inputs).map(([name, slot]) => ({ name, shape: slot.shape.join(", "), dtype: slot.dtype }));
    targets = Object.entries(dataset.definition.batch.targets).map(([name, slot]) => ({ name, shape: slot.shape.join(", "), dtype: slot.dtype }));
    classCount = dataset.definition.classes ? String(dataset.definition.classes.count) : "";
    classNames = dataset.definition.classes?.names?.join(", ") ?? "";
    files = dataset.dataFiles.map((file) => ({ path: file.path, bytes: new Uint8Array(file.bytes) }));
    error = null;
    success = false;
  }

  async function deleteDataset(): Promise<void> {
    if (!pendingDeletion || deleting) return;
    deleting = true;
    error = null;
    try {
      if (onDeleteRequest) await onDeleteRequest(pendingDeletion.modelDataset);
      if (selectedDataset && sameDatasetIdentity(selectedDataset.modelDataset, pendingDeletion.modelDataset)) resetForm();
      else pendingDeletion = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      deleting = false;
    }
  }

  function sameDatasetIdentity(left: ModelDatasetReference, right: ModelDatasetReference): boolean {
    return left.id === right.id && left.version === right.version && left.path === right.path;
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
    const classCountValue = typeof classCount === "number" ? String(classCount) : classCount ?? "";
    const classNamesValue = typeof classNames === "string" ? classNames : "";
    const parsedParameters = parameters.map((row) => {
      if (!row.defaultValue.trim()) {
        return { name: row.name, type: row.type, required: row.required };
      }
      if (row.type === "boolean") {
        const value = row.defaultValue.trim();
        if (value !== "true" && value !== "false") {
          throw new Error(t("Dataset parameter '{name}' boolean default must be true or false", { name: row.name }));
        }
        return { name: row.name, type: row.type, required: row.required, default: value === "true" };
      }
      return {
        name: row.name,
        type: row.type,
        required: row.required,
        default: row.type === "integer" || row.type === "number" ? Number(row.defaultValue) : row.defaultValue,
      };
    });
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
      if (selectedDataset) {
        if (onUpdateRequest) await onUpdateRequest(selectedDataset.modelDataset, request);
      } else if (onAuthoringRequest) await onAuthoringRequest(request);
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
    <h3>{t("Current project datasets")}</h3>
    {#if projectDatasets.length === 0}<p class="package-manager__empty">{t("No project datasets yet.")}</p>{/if}
    {#each projectDatasets as dataset (`${dataset.modelDataset.id}@${dataset.modelDataset.version}`)}
      <div class="package-manager__row">
        <span><strong>{dataset.definition.name}</strong><small>{dataset.modelDataset.id}@{dataset.modelDataset.version}</small></span>
        <div class="dataset-form__catalog-actions">
          <button type="button" onclick={() => editDataset(dataset)}>{t("Edit")}</button>
          <button type="button" class="dataset-form__delete" onclick={() => (pendingDeletion = dataset)}>{t("Delete")}</button>
        </div>
      </div>
    {/each}
  </div>
  <div class="stereotype-form__heading"><div><h3 id="dataset-form-title">{isEditing ? t("Edit dataset") : t("Author dataset")}</h3><p>{isEditing ? t("Update the dataset contract while preserving its Python source and existing data files.") : t("Generate a manifest, editable Python scaffold, and project-local data directory.")}</p></div>{#if isEditing}<button type="button" onclick={resetForm}>{t("New dataset")}</button>{/if}</div>
  {#if pendingDeletion}
    <div class="package-manager__message package-manager__message--error" role="alert">
      {t("Delete {name}, its project folder, and its active training entry?", { name: pendingDeletion.definition.name })}
      <div class="dataset-form__confirmation-actions"><button type="button" onclick={() => (pendingDeletion = null)} disabled={deleting}>{t("Cancel")}</button><button type="button" class="dataset-form__delete" onclick={deleteDataset} disabled={deleting}>{deleting ? t("Deleting…") : t("Delete dataset")}</button></div>
    </div>
  {/if}
  {#if error}<p class="package-manager__message package-manager__message--error" role="alert">{t(error)}</p>{:else if success}<p class="package-manager__message" role="status">{isEditing ? t("Dataset updated.") : t("Dataset created.")}</p>{/if}

  <fieldset disabled={submitting || readingFiles}><legend>{t("Identity and metadata")}</legend><div class="stereotype-form__grid">
    <label>ID <input required bind:value={id} autocomplete="off" readonly={isEditing} /></label>
    <label>{t("Version")} <input required bind:value={version} autocomplete="off" readonly={isEditing} /></label>
    <label class="stereotype-form__wide">{t("Directory")} <input required bind:value={directory} autocomplete="off" readonly={isEditing} aria-describedby="dataset-directory-help" /></label>
    <label class="stereotype-form__wide">{t("Name")} <input required bind:value={name} /></label>
    <label class="stereotype-form__wide">{t("Description")} <textarea bind:value={description} rows="2"></textarea></label>
  </div><small id="dataset-directory-help" class="stereotype-form__help">{t("Normalized path under {directory}; generated source never reads outside it.", { directory: "datasets/" })}</small></fieldset>

  <fieldset disabled={submitting || readingFiles}><legend>{t("Parameters")}</legend>
    {#if parameters.length === 0}<p class="package-manager__empty">{t("No configurable parameters.")}</p>{/if}
    {#each parameters as parameter, index (index)}<div class="dataset-form__row dataset-form__parameter-row">
      <input aria-label={t("Parameter {number} name", { number: index + 1 })} placeholder={t("name")} value={parameter.name} oninput={(event) => updateParameter(index, { name: (event.target as HTMLInputElement).value })} />
      <select aria-label={t("Parameter {number} type", { number: index + 1 })} value={parameter.type} onchange={(event) => updateParameter(index, { type: (event.target as HTMLSelectElement).value as ParameterRow["type"] })}><option value="string">{t("string")}</option><option value="integer">{t("integer")}</option><option value="number">{t("number")}</option><option value="boolean">{t("boolean")}</option></select>
      <label class="parameter-row__checkbox"><input type="checkbox" checked={parameter.required} onchange={(event) => updateParameter(index, { required: (event.target as HTMLInputElement).checked })} /> {t("required")}</label>
      <input aria-label={t("Parameter {number} default", { number: index + 1 })} placeholder={t("default")} value={parameter.defaultValue} oninput={(event) => updateParameter(index, { defaultValue: (event.target as HTMLInputElement).value })} />
      <button type="button" class="dataset-form__remove" onclick={() => removeParameter(index)} aria-label={t("Remove parameter {name}", { name: parameter.name })}>×</button>
    </div>{/each}
    <button type="button" class="parameter-form__add" onclick={addParameter}>+ {t("Add parameter")}</button>
  </fieldset>

  {#each [{ kind: "input", title: "Named input slots", rows: inputs }, { kind: "target", title: "Named target slots", rows: targets }] as group (group.kind)}
    <fieldset disabled={submitting || readingFiles}><legend>{t(group.title)}</legend>
      {#each group.rows as slot, index (index)}<div class="dataset-form__row dataset-form__slot-row">
        <input aria-label={t("{kind} slot {number} name", { kind: t(group.kind), number: index + 1 })} placeholder={t("slot name")} value={slot.name} oninput={(event) => updateSlot(group.kind as "input" | "target", index, { name: (event.target as HTMLInputElement).value })} />
        <input aria-label={t("{kind} slot {number} shape", { kind: t(group.kind), number: index + 1 })} placeholder="B, T" value={slot.shape} oninput={(event) => updateSlot(group.kind as "input" | "target", index, { shape: (event.target as HTMLInputElement).value })} />
        <select aria-label={t("{kind} slot {number} dtype", { kind: t(group.kind), number: index + 1 })} value={slot.dtype} onchange={(event) => updateSlot(group.kind as "input" | "target", index, { dtype: (event.target as HTMLSelectElement).value as DType })}>{#each dtypes as dtype}<option value={dtype}>{dtype}</option>{/each}</select>
        <button type="button" class="dataset-form__remove" onclick={() => removeSlot(group.kind as "input" | "target", index)} aria-label={t("Remove {kind} slot {name}", { kind: t(group.kind), name: slot.name })}>×</button>
      </div>{/each}
      <button type="button" class="parameter-form__add" onclick={() => addSlot(group.kind as "input" | "target")}>+ {t("Add slot")}</button>
    </fieldset>
  {/each}

  <fieldset disabled={submitting || readingFiles}><legend>{t("Classes and local data")}</legend>
    <div class="stereotype-form__grid"><label>{t("Class count")} <input type="number" min="1" step="1" bind:value={classCount} /></label><label>{t("Class names")} <input bind:value={classNames} placeholder={t("cat, dog")} /></label></div>
    <label class="dataset-form__file-picker">{t("Add files under {directory}", { directory: "data/" })}<input type="file" multiple onchange={handleFileSelection} /></label>
    {#if readingFiles}<p class="package-manager__empty">{t("Reading selected files…")}</p>{/if}
    {#each fileFeedback as file (file.path)}<div class="dataset-form__file-row"><span>{file.path}</span><small>{t("{size} bytes · {total} bytes total", { size: file.size.toLocaleString(), total: file.totalSize.toLocaleString() })}</small></div>{/each}
    <small class="stereotype-form__help">{t("Files are copied into the dataset directory. Symlinks and external paths are not accepted.")}</small>
  </fieldset>
  <button class="stereotype-form__submit" type="submit" disabled={submitting || readingFiles || deleting} aria-busy={submitting}>{submitting ? (isEditing ? t("Saving…") : t("Creating…")) : (isEditing ? t("Save dataset") : t("Create project dataset"))}</button>
</form>
