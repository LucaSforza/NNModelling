<script lang="ts">
  import ProjectForm, { type ProjectFormSubmission } from "./ProjectForm.svelte";
  import {
    ProjectSelectionCancelledError,
    ProjectWorkspaceAdapter,
    ProjectWorkspaceError,
    type ProjectWorkspaceSession,
  } from "../project-workspace";

  export type ProjectStartProps = {
    readonly workspaceAdapter?: ProjectWorkspaceAdapter;
    readonly onOpen: (session: ProjectWorkspaceSession) => void | Promise<void>;
    readonly initialError?: string | null;
  };

  let { workspaceAdapter, onOpen, initialError = null }: ProjectStartProps = $props();
  let mode = $state<"chooser" | "new">("chooser");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let message = $state<string | null>(null);

  function adapter(): ProjectWorkspaceAdapter {
    return workspaceAdapter ?? new ProjectWorkspaceAdapter();
  }

  function showError(cause: unknown): void {
    if (cause instanceof ProjectSelectionCancelledError) {
      message = "Selezione annullata. Puoi riprovare.";
      return;
    }
    error = cause instanceof ProjectWorkspaceError
      ? cause.message
      : cause instanceof Error ? cause.message : String(cause);
  }

  async function openProject(): Promise<void> {
    error = null;
    message = null;
    busy = true;
    try {
      await onOpen(await adapter().openProject());
    } catch (cause) {
      showError(cause);
    } finally {
      busy = false;
    }
  }

  async function createProject({ manifest, modelJson }: ProjectFormSubmission): Promise<void> {
    error = null;
    message = null;
    busy = true;
    try {
      await onOpen(await adapter().newProject(manifest.id, modelJson));
    } catch (cause) {
      showError(cause);
    } finally {
      busy = false;
    }
  }

  function startNew(): void {
    error = null;
    message = null;
    mode = "new";
  }

  function cancelNew(): void {
    error = null;
    message = null;
    mode = "chooser";
  }
</script>

<main class="project-start" aria-busy={busy}>
  {#if mode === "chooser"}
    <section class="project-card" aria-labelledby="project-start-title">
      <p class="eyebrow">NNModelling</p>
      <h1 id="project-start-title">Apri un progetto</h1>
      <p class="project-lead">Scegli una cartella di progetto per iniziare a costruire il tuo modello.</p>
      <div class="project-actions">
        <button class="primary" type="button" onclick={startNew} disabled={busy}>＋ Nuovo progetto</button>
        <button class="secondary" type="button" onclick={openProject} disabled={busy}>↗ Apri progetto</button>
      </div>
      {#if error ?? initialError}
        <p class="project-error" role="alert">{error ?? initialError}</p>
      {/if}
      {#if message}
        <p class="project-message" role="status">{message}</p>
      {/if}
    </section>
  {:else}
    <ProjectForm onSubmit={createProject} onCancel={cancelNew} submitting={busy} />
  {/if}
</main>

<style global>
  @import "../styles/project-start.css";
</style>
