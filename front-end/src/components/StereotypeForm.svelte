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

  interface Props {
    onAuthoringRequest?: (request: StereotypeAuthoringRequest) => Promise<void> | void;
    onSubmit?: (request: StereotypeAuthoringRequest) => Promise<void> | void;
  }

  let { onAuthoringRequest, onSubmit }: Props = $props();
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
    <div><h3 id="stereotype-form-title">Author stereotype</h3><p>Submit one validated domain request for the active project.</p></div>
  </div>

  {#if error}
    <p class="package-manager__message package-manager__message--error" role="alert">{error}</p>
  {:else if success}
    <p class="package-manager__message" role="status" aria-live="polite">Stereotype request submitted.</p>
  {/if}

  <fieldset disabled={submitting}>
    <legend>Identity</legend>
    <div class="stereotype-form__grid">
      <label>ID <input required bind:value={id} autocomplete="off" aria-describedby="stereotype-id-help" /></label>
      <label>Version <input required bind:value={version} autocomplete="off" /></label>
      <label class="stereotype-form__wide">Directory <input required bind:value={directory} autocomplete="off" aria-describedby="stereotype-directory-help" /></label>
      <label class="stereotype-form__wide">Name <input required bind:value={name} /></label>
      <label class="stereotype-form__wide">Description <textarea bind:value={description} rows="2"></textarea></label>
    </div>
    <small id="stereotype-id-help" class="stereotype-form__help">Lowercase package id, for example <code>model.attention</code>.</small>
    <small id="stereotype-directory-help" class="stereotype-form__help">A normalized path relative to the project.</small>
  </fieldset>

  <fieldset disabled={submitting}>
    <legend>Presentation and kind</legend>
    <div class="stereotype-form__grid">
      <label>Kind <select bind:value={kind}><option value="input">Input</option><option value="layer">Layer</option><option value="loss">Loss</option><option value="join">Join</option><option value="subflow">Subflow</option><option value="output">Output</option></select></label>
      <label>Color <input type="color" bind:value={color} /></label>
      <label>Width <input type="number" min="1" step="1" bind:value={width} /></label>
      <label>Height <input type="number" min="1" step="1" bind:value={height} /></label>
    </div>
  </fieldset>

  <fieldset disabled={submitting}>
    <legend>Dependencies</legend>
    <label>Package dependencies <textarea bind:value={dependencyText} rows="3" placeholder="core.relu ^0.1.0"></textarea></label>
    <small class="stereotype-form__help">One <code>id range</code> per line; <code>:</code> and <code>=</code> are also accepted.</small>
  </fieldset>

  <ParameterForm value={parameters} onChange={(next) => (parameters = next)} disabled={submitting} />

  <button class="stereotype-form__submit" type="submit" disabled={submitting} aria-busy={submitting}>{submitting ? "Submitting…" : "Submit stereotype"}</button>
</form>
