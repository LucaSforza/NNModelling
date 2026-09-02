<script lang="ts">
  import { DTYPES, type DType, type Dimension } from "../type-system/tensor-type";
  import type { PackageKind } from "../type-system/packages/types";
  import type { AuthoringParameterDefinition, StereotypeParameterRequest } from "../stereotype-authoring/types";

  type ParameterType = AuthoringParameterDefinition["type"];
  type ScalarType = "integer" | "number" | "boolean" | "string";
  type DraftRow = {
    key: number; name: string; type: ParameterType; position: "top" | "bottom";
    minimum: string; maximum: string; defaultValue: string; defaultBoolean: boolean;
    choices: string; dtypeChoices: string; shape: string; listItemType: ScalarType;
    listMinItems: string; listMaxItems: string; listDefault: string; listItemDefault: string; listItemDefaultBoolean: boolean;
    stereotypeKind: PackageKind; stereotypeId: string; stereotypeVersion: string; stereotypeParameters: string;
  };

  interface Props {
    value?: readonly StereotypeParameterRequest[];
    onChange?: (value: readonly StereotypeParameterRequest[]) => void;
    disabled?: boolean;
  }

  let { value = [], onChange, disabled = false }: Props = $props();
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

  function numberValue(value: string): number | undefined {
    if (!value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  function optionalString(value: string): string | undefined { return value.trim() ? value : undefined; }
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
  <legend>Parameters</legend>
  {#if rows.length === 0}<p class="parameter-form__empty">No parameters. Add one when the stereotype needs configurable values.</p>{/if}
  {#each rows as row, index (row.key)}
    <div class="parameter-row" aria-label={`Parameter ${index + 1}`}>
      <div class="parameter-row__header">
        <strong>Parameter {index + 1}</strong>
        <div class="parameter-row__actions">
          <button type="button" title="Move parameter up" aria-label={`Move parameter ${index + 1} up`} onclick={() => move(index, -1)} disabled={index === 0}>↑</button>
          <button type="button" title="Move parameter down" aria-label={`Move parameter ${index + 1} down`} onclick={() => move(index, 1)} disabled={index === rows.length - 1}>↓</button>
          <button type="button" title="Remove parameter" aria-label={`Remove parameter ${index + 1}`} onclick={() => remove(index)}>Remove</button>
        </div>
      </div>
      <div class="parameter-row__grid">
        <label>Name <input required bind:value={row.name} oninput={emit} /></label>
        <label>Type <select value={row.type} onchange={(event) => changeType(row, (event.currentTarget as HTMLSelectElement).value as ParameterType)}><option value="integer">Integer</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="string">String</option><option value="dtype">DType</option><option value="shape">Shape</option><option value="list">List</option><option value="stereotype">Stereotype</option></select></label>
        <label>Position <select bind:value={row.position} onchange={emit}><option value="top">Top</option><option value="bottom">Bottom</option></select></label>
      </div>

      {#if row.type === "integer" || row.type === "number"}
        <div class="parameter-row__grid"><label>Minimum <input type="number" step={row.type === "integer" ? "1" : "any"} bind:value={row.minimum} oninput={emit} /></label><label>Maximum <input type="number" step={row.type === "integer" ? "1" : "any"} bind:value={row.maximum} oninput={emit} /></label><label>Default <input type="number" step={row.type === "integer" ? "1" : "any"} bind:value={row.defaultValue} oninput={emit} /></label></div>
      {:else if row.type === "boolean"}
        <label class="parameter-row__checkbox"><input type="checkbox" bind:checked={row.defaultBoolean} onchange={emit} /> Default true</label>
      {:else if row.type === "string"}
        <div class="parameter-row__grid"><label>Choices <input placeholder="small, medium, large" bind:value={row.choices} oninput={emit} /></label><label>Default <input bind:value={row.defaultValue} oninput={emit} /></label></div>
      {:else if row.type === "dtype"}
        <div class="parameter-row__grid"><label class="parameter-row__wide">DType choices <input bind:value={row.dtypeChoices} oninput={emit} /></label><label>Default <select bind:value={row.defaultValue} onchange={emit}><option value="">No default</option>{#each DTYPES as dtype}<option value={dtype}>{dtype}</option>{/each}</select></label></div>
      {:else if row.type === "shape"}
        <label>Default dimensions <input placeholder="B, 128, features" bind:value={row.shape} oninput={emit} /></label>
      {:else if row.type === "list"}
        <div class="parameter-row__grid"><label>Item type <select bind:value={row.listItemType} onchange={emit}><option value="integer">Integer</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="string">String</option></select></label><label>Minimum items <input type="number" min="0" step="1" bind:value={row.listMinItems} oninput={emit} /></label><label>Maximum items <input type="number" min="0" step="1" bind:value={row.listMaxItems} oninput={emit} /></label><label class="parameter-row__wide">Default JSON <input placeholder="[1, 2]" bind:value={row.listDefault} oninput={emit} /></label></div>
        {#if row.listItemType === "integer" || row.listItemType === "number"}<div class="parameter-row__grid"><label>Item minimum <input type="number" bind:value={row.minimum} oninput={emit} /></label><label>Item maximum <input type="number" bind:value={row.maximum} oninput={emit} /></label><label>Item default <input type="number" step={row.listItemType === "integer" ? "1" : "any"} bind:value={row.listItemDefault} oninput={emit} /></label></div>{:else if row.listItemType === "boolean"}<label class="parameter-row__checkbox"><input type="checkbox" bind:checked={row.listItemDefaultBoolean} onchange={emit} /> Item default true</label>{:else}<div class="parameter-row__grid"><label>Item choices <input bind:value={row.choices} oninput={emit} /></label><label>Item default <input bind:value={row.listItemDefault} oninput={emit} /></label></div>{/if}
      {:else}
        <div class="parameter-row__grid"><label>Referenced kind <select bind:value={row.stereotypeKind} onchange={emit}><option value="input">Input</option><option value="layer">Layer</option><option value="loss">Loss</option><option value="join">Join</option><option value="subflow">Subflow</option><option value="output">Output</option></select></label><label>Referenced ID <input bind:value={row.stereotypeId} oninput={emit} /></label><label>Version range <input bind:value={row.stereotypeVersion} oninput={emit} /></label><label class="parameter-row__wide">Default parameters JSON <input bind:value={row.stereotypeParameters} oninput={emit} /></label></div>
      {/if}
    </div>
  {/each}
  <button type="button" class="parameter-form__add" onclick={add}>Add parameter</button>
</fieldset>
