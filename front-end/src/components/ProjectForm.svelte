<script lang="ts">
  import type { ModelManifest } from "../core/types";
  import { createEmptyProjectJson, manifestFromProjectForm } from "../utils";
  import { useI18n } from "../i18n.svelte";

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
  const { t } = useI18n();
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
      <p class="eyebrow">{t("New project")}</p>
      <h1 id="project-form-title">{t("Describe your model")}</h1>
    </div>
    <button type="button" class="secondary" onclick={onCancel} disabled={submitting}>{t("Cancel")}</button>
  </div>

  <label>
    {t("Model ID")}
    <input bind:value={id} name="id" autocomplete="off" placeholder="e.g. vision.mnist" required />
    <small>{t("Lowercase letters, numbers, dots, and hyphens.")}</small>
  </label>
  <label>
    {t("Version")}
    <input bind:value={version} name="version" autocomplete="off" placeholder="0.1.0" required />
  </label>
  <label>
    {t("Name")}
    <input bind:value={name} name="name" autocomplete="off" placeholder={t("My model")} required />
  </label>
  <label>
    {t("Description")} <span>({t("optional")})</span>
    <textarea bind:value={description} name="description" rows="3" placeholder={t("What does this model do?")}></textarea>
  </label>

  {#if error}
    <p class="project-error" role="alert">{t(error)}</p>
  {/if}
  <button type="submit" class="primary" disabled={submitting}>
    {submitting ? t("Creating…") : t("Create project")}
  </button>
</form>
