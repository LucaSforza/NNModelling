<script module lang="ts">
  import { validateStereotypeAuthoringRequest as validateRequestForExport } from "../stereotype-authoring";
  import type { StereotypeAuthoringRequest as AuthoringRequestForExport } from "../stereotype-authoring";

  /** Parse the deliberately small, line-oriented dependency editor. */
  export function parseDependencyText(value: string): Readonly<Record<string, string>> {
    const dependencies: Record<string, string> = {};
    for (const [index, line] of value.split("\n").map((item) => item.trim()).entries()) {
      if (!line) continue;
      const match = line.match(/^([^\s:=]+)\s*(?:=|:)\s*(\S+)$/) ?? line.match(/^(\S+)\s+(\S+)$/);
      if (!match) throw new Error(`Dependency line ${index + 1} must contain an id and version range`);
      if (dependencies[match[1]]) throw new Error(`Dependency '${match[1]}' is duplicated`);
      dependencies[match[1]] = match[2];
    }
    return dependencies;
  }

  export function validateFormRequest(request: AuthoringRequestForExport) {
    return validateRequestForExport(request);
  }
</script>

<script lang="ts">
  import { validateStereotypeAuthoringRequest, type StereotypeAuthoringRequest } from "../stereotype-authoring";
  import type { PackageKind } from "../type-system/packages/types";
  import ParameterForm from "./ParameterForm.svelte";
  import type { StereotypeParameterRequest } from "../stereotype-authoring/types";
  import { useI18n } from "../i18n.svelte";

  interface Props {
    onAuthoringRequest?: (request: StereotypeAuthoringRequest) => Promise<void> | void;
    onSubmit?: (request: StereotypeAuthoringRequest) => Promise<void> | void;
  }

  let { onAuthoringRequest, onSubmit }: Props = $props();
  const { t } = useI18n();
  let id = $state("model.custom");
  let version = $state("1.0.0");
  let directory = $state("packages/model-custom");
  let name = $state("Custom stereotype");
  let description = $state("");
  let kind = $state<PackageKind>("layer");
  let color = $state("#64748b");
  let width = $state(240);
  let height = $state(120);
  let dependencyText = $state("");
  let parameters = $state<readonly StereotypeParameterRequest[]>([]);
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let success = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    error = null;
    success = false;
    try {
      const request: StereotypeAuthoringRequest = {
        id, version, directory, name,
        ...(description.trim() ? { description } : {}),
        kind, view: { color, width, height },
        dependencies: parseDependencyText(dependencyText),
        parameters,
      };
      const validated = validateStereotypeAuthoringRequest(request);
      const callback = onAuthoringRequest ?? onSubmit;
      if (callback) await callback(validated);
      success = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      submitting = false;
    }
  }
</script>

<form class="stereotype-form" onsubmit={submit} aria-labelledby="stereotype-form-title">
  <div class="stereotype-form__heading">
    <div><h3 id="stereotype-form-title">{t("Author stereotype")}</h3><p>{t("Submit one validated domain request for the active project.")}</p></div>
  </div>

  {#if error}
    <p class="package-manager__message package-manager__message--error" role="alert">{t(error)}</p>
  {:else if success}
    <p class="package-manager__message" role="status" aria-live="polite">{t("Stereotype request submitted.")}</p>
  {/if}

  <fieldset disabled={submitting}>
    <legend>{t("Identity")}</legend>
    <div class="stereotype-form__grid">
      <label>ID <input required bind:value={id} autocomplete="off" aria-describedby="stereotype-id-help" /></label>
      <label>{t("Version")} <input required bind:value={version} autocomplete="off" /></label>
      <label class="stereotype-form__wide">{t("Directory")} <input required bind:value={directory} autocomplete="off" aria-describedby="stereotype-directory-help" /></label>
      <label class="stereotype-form__wide">{t("Name")} <input required bind:value={name} /></label>
      <label class="stereotype-form__wide">{t("Description")} <textarea bind:value={description} rows="2"></textarea></label>
    </div>
    <small id="stereotype-id-help" class="stereotype-form__help">{t("Lowercase package ID, for example")} <code>model.attention</code>.</small>
    <small id="stereotype-directory-help" class="stereotype-form__help">{t("A normalized path relative to the project.")}</small>
  </fieldset>

  <fieldset disabled={submitting}>
    <legend>{t("Presentation and kind")}</legend>
    <div class="stereotype-form__grid">
      <label>{t("Kind")} <select bind:value={kind}><option value="input">{t("Input")}</option><option value="layer">{t("Layer")}</option><option value="loss">{t("Loss")}</option><option value="join">{t("Join")}</option><option value="subflow">{t("Subflow")}</option><option value="output">{t("Output")}</option></select></label>
      <label>{t("Color")} <input type="color" bind:value={color} /></label>
      <label>{t("Width")} <input type="number" min="1" step="1" bind:value={width} /></label>
      <label>{t("Height")} <input type="number" min="1" step="1" bind:value={height} /></label>
    </div>
  </fieldset>

  <fieldset disabled={submitting}>
    <legend>{t("Dependencies")}</legend>
    <label>{t("Package dependencies")} <textarea bind:value={dependencyText} rows="3" placeholder="core.relu ^0.1.0"></textarea></label>
    <small class="stereotype-form__help">{t("One {format} per line; {colon} and {equals} are also accepted.", { format: "id range", colon: ":", equals: "=" })}</small>
  </fieldset>

  <ParameterForm value={parameters} onChange={(next) => (parameters = next)} disabled={submitting} />

  <button class="stereotype-form__submit" type="submit" disabled={submitting} aria-busy={submitting}>{submitting ? t("Submitting…") : t("Submit stereotype")}</button>
</form>
