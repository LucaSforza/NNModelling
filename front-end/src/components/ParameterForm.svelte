<script lang="ts">
  import { DTYPES, type DType, type Dimension } from "../type-system/tensor-type";
  import type { PackageKind } from "../type-system/packages/types";
  import type { AuthoringParameterDefinition, StereotypeParameterRequest } from "../stereotype-authoring/types";
  import { useI18n } from "../i18n.svelte";

  type ParameterType = AuthoringParameterDefinition["type"];
  type ScalarType = "integer" | "number" | "boolean" | "string";
  type NumericDraftValue = string | number | undefined;
  type DraftRow = {
    key: number; name: string; type: ParameterType; position: "top" | "bottom";
    minimum: NumericDraftValue; maximum: NumericDraftValue; defaultValue: NumericDraftValue; defaultBoolean: boolean;
    choices: string; dtypeChoices: string; shape: string; listItemType: ScalarType;
    listMinItems: NumericDraftValue; listMaxItems: NumericDraftValue; listDefault: string; listItemDefault: NumericDraftValue; listItemDefaultBoolean: boolean;
    stereotypeKind: PackageKind; stereotypeId: string; stereotypeVersion: string; stereotypeParameters: string;
  };

  interface Props {
    value?: readonly StereotypeParameterRequest[];
    onChange?: (value: readonly StereotypeParameterRequest[]) => void;
    disabled?: boolean;
  }

  let { value = [], onChange, disabled = false }: Props = $props();
  const { t } = useI18n();
  let sequence = 0;
  const initialValue = value;
  let rows = $state<DraftRow[]>(initialValue.map((item) => fromRequest(item)));

  function freshRow(): DraftRow {
    return {
      key: sequence++, name: "parameter", type: "string", position: "top",
      minimum: "", maximum: "", defaultValue: "", defaultBoolean: false,
      choices: "", dtypeChoices: "float32", shape: "", listItemType: "string",
      listMinItems: "", listMaxItems: "", listDefault: "", listItemDefault: "", listItemDefaultBoolean: false, stereotypeKind: "layer",
      stereotypeId: "core.relu", stereotypeVersion: "^0.1.0", stereotypeParameters: "{}",
    };
  }

  function fromRequest(item: StereotypeParameterRequest): DraftRow {
    const row = freshRow();
    const definition = item.definition;
    row.name = item.name;
    row.type = definition.type;
    row.position = definition.position;
    if (definition.type === "integer" || definition.type === "number") {
      row.minimum = definition.minimum === undefined ? "" : String(definition.minimum);
      row.maximum = definition.maximum === undefined ? "" : String(definition.maximum);
      row.defaultValue = definition.default === undefined ? "" : String(definition.default);
    } else if (definition.type === "boolean") row.defaultBoolean = definition.default ?? false;
    else if (definition.type === "string") { row.choices = definition.choices?.join(", ") ?? ""; row.defaultValue = definition.default ?? ""; }
    else if (definition.type === "dtype") { row.dtypeChoices = definition.choices.join(", "); row.defaultValue = definition.default ?? ""; }
    else if (definition.type === "shape") row.shape = definition.default?.join(", ") ?? "";
    else if (definition.type === "list") {
      row.listItemType = definition.items.type;
      if (definition.items.type === "integer" || definition.items.type === "number") row.listItemDefault = definition.items.default === undefined ? "" : String(definition.items.default);
      else if (definition.items.type === "boolean") row.listItemDefaultBoolean = definition.items.default ?? false;
      else row.listItemDefault = definition.items.default ?? "";
      if (definition.items.type === "string") row.choices = definition.items.choices?.join(", ") ?? "";
      row.listMinItems = definition.minItems === undefined ? "" : String(definition.minItems);
      row.listMaxItems = definition.maxItems === undefined ? "" : String(definition.maxItems);
      row.listDefault = definition.default === undefined ? "" : JSON.stringify(definition.default);
    } else {
      row.stereotypeKind = definition.kind;
      row.stereotypeId = definition.default?.id ?? row.stereotypeId;
      row.stereotypeVersion = definition.default?.version ?? row.stereotypeVersion;
      row.stereotypeParameters = definition.default ? JSON.stringify(definition.default.parameters) : "{}";
    }
    return row;
  }

  function numberValue(value: unknown): number | undefined {
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return undefined;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  function numberError(value: unknown, type: "integer" | "number"): string | undefined {
    const parsed = numberValue(value);
    if (parsed === undefined) return undefined;
    if (!Number.isFinite(parsed)) return t("Enter a finite number.");
    if (type === "integer" && !Number.isInteger(parsed)) return t("Enter a whole number.");
    return undefined;
  }
  function boundsError(minimum: unknown, maximum: unknown, defaultValue: unknown, type: "integer" | "number"): string | undefined {
    const min = numberValue(minimum);
    const max = numberValue(maximum);
    const value = numberValue(defaultValue);
    if (min !== undefined && max !== undefined && Number.isFinite(min) && Number.isFinite(max) && min > max) return t("Minimum must not exceed maximum.");
    if (value !== undefined && Number.isFinite(value)) {
      if (min !== undefined && Number.isFinite(min) && value < min) return t("Default is below the minimum.");
      if (max !== undefined && Number.isFinite(max) && value > max) return t("Default is above the maximum.");
    }
    return undefined;
  }
  function listLengthError(minimum: unknown, maximum: unknown, defaultValue: string): string | undefined {
    const min = numberValue(minimum);
    const max = numberValue(maximum);
    if (min !== undefined && max !== undefined && Number.isFinite(min) && Number.isFinite(max) && min > max) return t("Minimum items must not exceed maximum items.");
    if (!defaultValue.trim()) return undefined;
    const parsed = jsonValue(defaultValue);
    if (!Array.isArray(parsed)) return t("Default must be a JSON list.");
    if (min !== undefined && Number.isFinite(min) && parsed.length < min) return t("Default has fewer items than the minimum.");
    if (max !== undefined && Number.isFinite(max) && parsed.length > max) return t("Default has more items than the maximum.");
    return undefined;
  }
  function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
  }
  function split(value: string): string[] | undefined {
    const entries = value.split(",").map((item) => item.trim()).filter(Boolean);
    return entries.length ? entries : undefined;
  }
  function dimensions(value: string): readonly Dimension[] | undefined {
    const entries = split(value);
    return entries?.map((item) => /^-?\d+(?:\.\d+)?$/.test(item) ? Number(item) : item);
  }
  function jsonValue(value: string): unknown {
    if (!value.trim()) return undefined;
    try { return JSON.parse(value); } catch { return null; }
  }
  function itemDefinition(row: DraftRow): AuthoringParameterDefinition {
    if (row.listItemType === "integer" || row.listItemType === "number") return { type: row.listItemType, minimum: numberValue(row.minimum), maximum: numberValue(row.maximum), default: numberValue(row.listItemDefault) } as AuthoringParameterDefinition;
    if (row.listItemType === "boolean") return { type: "boolean", default: row.listItemDefaultBoolean } as AuthoringParameterDefinition;
    return { type: "string", choices: split(row.choices), default: optionalString(row.listItemDefault) } as AuthoringParameterDefinition;
  }
  function definition(row: DraftRow): AuthoringParameterDefinition {
    const position = row.position;
    if (row.type === "integer" || row.type === "number") return { type: row.type, minimum: numberValue(row.minimum), maximum: numberValue(row.maximum), default: numberValue(row.defaultValue), position } as AuthoringParameterDefinition;
    if (row.type === "boolean") return { type: "boolean", default: row.defaultBoolean, position };
    if (row.type === "string") return { type: "string", choices: split(row.choices), default: optionalString(row.defaultValue), position };
    if (row.type === "dtype") return { type: "dtype", choices: (split(row.dtypeChoices) ?? []) as DType[], default: optionalString(row.defaultValue) as DType | undefined, position };
    if (row.type === "shape") return { type: "shape", default: dimensions(row.shape), position };
    if (row.type === "list") return { type: "list", items: itemDefinition(row) as never, minItems: numberValue(row.listMinItems), maxItems: numberValue(row.listMaxItems), default: jsonValue(row.listDefault) as readonly unknown[] | undefined, position };
    const defaultValue = jsonValue(row.stereotypeParameters);
    return { type: "stereotype", kind: row.stereotypeKind, default: { id: row.stereotypeId, version: row.stereotypeVersion, parameters: (defaultValue ?? {}) as Record<string, unknown> }, position };
  }
  function emit() { onChange?.(rows.map((row) => ({ name: row.name, definition: definition(row) })) as readonly StereotypeParameterRequest[]); }
  function add() { rows.push(freshRow()); emit(); }
  function remove(index: number) { rows.splice(index, 1); emit(); }
  function move(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= rows.length) return;
    [rows[index], rows[target]] = [rows[target], rows[index]];
    emit();
  }
  function changeType(row: DraftRow, type: ParameterType) {
    const replacement = freshRow();
    replacement.name = row.name;
    replacement.position = row.position;
    replacement.type = type;
    rows[rows.indexOf(row)] = replacement;
    emit();
  }
</script>

<fieldset class="parameter-form" disabled={disabled}>
  <legend>{t("Parameters")}</legend>
  {#if rows.length === 0}<p class="parameter-form__empty">{t("No parameters. Add one when the stereotype needs configurable values.")}</p>{/if}
  {#each rows as row, index (row.key)}
    <div class="parameter-row" aria-label={t("Parameter {number}", { number: index + 1 })}>
      <div class="parameter-row__header">
        <strong>{t("Parameter {number}", { number: index + 1 })}</strong>
        <div class="parameter-row__actions">
          <button type="button" title={t("Move parameter up")} aria-label={t("Move parameter {number} up", { number: index + 1 })} onclick={() => move(index, -1)} disabled={index === 0}>↑</button>
          <button type="button" title={t("Move parameter down")} aria-label={t("Move parameter {number} down", { number: index + 1 })} onclick={() => move(index, 1)} disabled={index === rows.length - 1}>↓</button>
          <button type="button" title={t("Remove parameter")} aria-label={t("Remove parameter {number}", { number: index + 1 })} onclick={() => remove(index)}>{t("Remove")}</button>
        </div>
      </div>
      <div class="parameter-row__grid">
        <label>{t("Name")} <input required bind:value={row.name} oninput={emit} /></label>
        <label>{t("Type")} <select value={row.type} onchange={(event) => changeType(row, (event.currentTarget as HTMLSelectElement).value as ParameterType)}><option value="integer">{t("Integer")}</option><option value="number">{t("Number")}</option><option value="boolean">{t("Boolean")}</option><option value="string">{t("String")}</option><option value="dtype">DType</option><option value="shape">{t("Shape")}</option><option value="list">{t("List")}</option><option value="stereotype">{t("Stereotype")}</option></select></label>
        <label>{t("Position")} <select bind:value={row.position} onchange={emit}><option value="top">{t("Top")}</option><option value="bottom">{t("Bottom")}</option></select></label>
      </div>

      {#if row.type === "integer" || row.type === "number"}
        <div class="parameter-row__grid"><label>{t("Minimum")} <input type="number" step={row.type === "integer" ? "1" : "any"} bind:value={row.minimum} oninput={emit} />{#if numberError(row.minimum, row.type)}<small class="parameter-form__error" role="alert">{numberError(row.minimum, row.type)}</small>{/if}</label><label>{t("Maximum")} <input type="number" step={row.type === "integer" ? "1" : "any"} bind:value={row.maximum} oninput={emit} />{#if numberError(row.maximum, row.type)}<small class="parameter-form__error" role="alert">{numberError(row.maximum, row.type)}</small>{/if}</label><label>{t("Default")} <input type="number" step={row.type === "integer" ? "1" : "any"} bind:value={row.defaultValue} oninput={emit} />{#if numberError(row.defaultValue, row.type)}<small class="parameter-form__error" role="alert">{numberError(row.defaultValue, row.type)}</small>{/if}</label></div>
        {#if boundsError(row.minimum, row.maximum, row.defaultValue, row.type)}<small class="parameter-form__error" role="alert">{boundsError(row.minimum, row.maximum, row.defaultValue, row.type)}</small>{/if}
      {:else if row.type === "boolean"}
        <label class="parameter-row__checkbox"><input type="checkbox" bind:checked={row.defaultBoolean} onchange={emit} /> {t("Default true")}</label>
      {:else if row.type === "string"}
        <div class="parameter-row__grid"><label>{t("Choices")} <input placeholder={t("small, medium, large")} bind:value={row.choices} oninput={emit} /></label><label>{t("Default")} <input bind:value={row.defaultValue} oninput={emit} /></label></div>
      {:else if row.type === "dtype"}
        <div class="parameter-row__grid"><label class="parameter-row__wide">{t("DType choices")} <input bind:value={row.dtypeChoices} oninput={emit} /></label><label>{t("Default")} <select bind:value={row.defaultValue} onchange={emit}><option value="">{t("No default")}</option>{#each DTYPES as dtype}<option value={dtype}>{dtype}</option>{/each}</select></label></div>
      {:else if row.type === "shape"}
        <label>{t("Default dimensions")} <input placeholder="B, 128, features" bind:value={row.shape} oninput={emit} /></label>
      {:else if row.type === "list"}
        <div class="parameter-row__grid"><label>{t("Item type")} <select bind:value={row.listItemType} onchange={emit}><option value="integer">{t("Integer")}</option><option value="number">{t("Number")}</option><option value="boolean">{t("Boolean")}</option><option value="string">{t("String")}</option></select></label><label>{t("Minimum items")} <input type="number" min="0" step="1" bind:value={row.listMinItems} oninput={emit} />{#if numberError(row.listMinItems, "integer")}<small class="parameter-form__error" role="alert">{numberError(row.listMinItems, "integer")}</small>{/if}</label><label>{t("Maximum items")} <input type="number" min="0" step="1" bind:value={row.listMaxItems} oninput={emit} />{#if numberError(row.listMaxItems, "integer")}<small class="parameter-form__error" role="alert">{numberError(row.listMaxItems, "integer")}</small>{/if}</label><label class="parameter-row__wide">{t("Default JSON")} <input placeholder="[1, 2]" bind:value={row.listDefault} oninput={emit} /></label></div>
        {#if listLengthError(row.listMinItems, row.listMaxItems, row.listDefault)}<small class="parameter-form__error" role="alert">{listLengthError(row.listMinItems, row.listMaxItems, row.listDefault)}</small>{/if}
        {#if row.listItemType === "integer" || row.listItemType === "number"}<div class="parameter-row__grid"><label>{t("Item minimum")} <input type="number" step={row.listItemType === "integer" ? "1" : "any"} bind:value={row.minimum} oninput={emit} />{#if numberError(row.minimum, row.listItemType)}<small class="parameter-form__error" role="alert">{numberError(row.minimum, row.listItemType)}</small>{/if}</label><label>{t("Item maximum")} <input type="number" step={row.listItemType === "integer" ? "1" : "any"} bind:value={row.maximum} oninput={emit} />{#if numberError(row.maximum, row.listItemType)}<small class="parameter-form__error" role="alert">{numberError(row.maximum, row.listItemType)}</small>{/if}</label><label>{t("Item default")} <input type="number" step={row.listItemType === "integer" ? "1" : "any"} bind:value={row.listItemDefault} oninput={emit} />{#if numberError(row.listItemDefault, row.listItemType)}<small class="parameter-form__error" role="alert">{numberError(row.listItemDefault, row.listItemType)}</small>{/if}</label></div>{#if boundsError(row.minimum, row.maximum, row.listItemDefault, row.listItemType)}<small class="parameter-form__error" role="alert">{boundsError(row.minimum, row.maximum, row.listItemDefault, row.listItemType)}</small>{/if}{:else if row.listItemType === "boolean"}<label class="parameter-row__checkbox"><input type="checkbox" bind:checked={row.listItemDefaultBoolean} onchange={emit} /> {t("Item default true")}</label>{:else}<div class="parameter-row__grid"><label>{t("Item choices")} <input bind:value={row.choices} oninput={emit} /></label><label>{t("Item default")} <input bind:value={row.listItemDefault} oninput={emit} /></label></div>{/if}
      {:else}
        <div class="parameter-row__grid"><label>{t("Referenced kind")} <select bind:value={row.stereotypeKind} onchange={emit}><option value="input">{t("Input")}</option><option value="layer">{t("Layer")}</option><option value="loss">{t("Loss")}</option><option value="join">{t("Join")}</option><option value="subflow">{t("Subflow")}</option><option value="output">{t("Output")}</option></select></label><label>{t("Referenced ID")} <input bind:value={row.stereotypeId} oninput={emit} /></label><label>{t("Version range")} <input bind:value={row.stereotypeVersion} oninput={emit} /></label><label class="parameter-row__wide">{t("Default parameters JSON")} <input bind:value={row.stereotypeParameters} oninput={emit} /></label></div>
      {/if}
    </div>
  {/each}
  <button type="button" class="parameter-form__add" onclick={add}>{t("Add parameter")}</button>
</fieldset>
