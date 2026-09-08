<script lang="ts">
  import type { ModelManifest } from "../core/types";
  import { createEmptyProjectJson, manifestFromProjectForm } from "../utils";

  export type ProjectFormSubmission = {
    readonly manifest: ModelManifest;
    readonly modelJson: string;
  };

  export type ProjectFormProps = {
    readonly onSubmit: (submission: ProjectFormSubmission) => void | Promise<void>;
    readonly onCancel: () => void;
    readonly submitting?: boolean;
  };

  let { onSubmit, onCancel, submitting = false }: ProjectFormProps = $props();
  let id = $state("");
  let version = $state("0.1.0");
  let name = $state("");
  let description = $state("");
  let error = $state<string | null>(null);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    error = null;
    try {
      const manifest = manifestFromProjectForm({ id, version, name, description });
      await onSubmit({ manifest, modelJson: createEmptyProjectJson(manifest) });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
</script>

<form class="project-form" onsubmit={submit} aria-labelledby="project-form-title">
  <div class="project-form-heading">
    <div>
      <p class="eyebrow">Nuovo progetto</p>
      <h1 id="project-form-title">Descrivi il tuo modello</h1>
    </div>
    <button type="button" class="secondary" onclick={onCancel} disabled={submitting}>Annulla</button>
  </div>

  <label>
    ID modello
    <input bind:value={id} name="id" autocomplete="off" placeholder="es. vision.mnist" required />
    <small>Minuscole, numeri, punti e trattini.</small>
  </label>
  <label>
    Versione
    <input bind:value={version} name="version" autocomplete="off" placeholder="0.1.0" required />
  </label>
  <label>
    Nome
    <input bind:value={name} name="name" autocomplete="off" placeholder="Il mio modello" required />
  </label>
  <label>
    Descrizione <span>(opzionale)</span>
    <textarea bind:value={description} name="description" rows="3" placeholder="A cosa serve questo modello?"></textarea>
  </label>

  {#if error}
    <p class="project-error" role="alert">{error}</p>
  {/if}
  <button type="submit" class="primary" disabled={submitting}>
    {submitting ? "Creazione…" : "Crea progetto"}
  </button>
</form>
