<!--
NNModelling — DSL for designing neural networks via visual node editor
Copyright (C) 2026  Luca Sforza

Licensed under the GNU General Public License v3 or later.
Commercial licenses are available — contact Luca Sforza.
See the LICENSE file for details.
-->

<script lang="ts">
  import { projectState } from "../projects/state.svelte";

  interface Props {
    onOpenChooser: () => void;
  }

  let { onOpenChooser }: Props = $props();

  let active = $derived(projectState.active);
  let environment = $derived(active?.environment ?? null);
  let envLabel = $derived(
    environment
      ? { ready: "Ambiente pronto", missing: "Da sincronizzare", error: "Errore ambiente" }[environment.status]
      : "",
  );
  let saveLabel = $derived(
    projectState.saving ? "Salvataggio…" : projectState.saveSuccess ? "Salvato ✓" : "",
  );
  let syncBusy = $derived(projectState.busy);

  async function handleSync() {
    await projectState.syncActive();
  }
</script>

{#if active}
  <div class="project-status" role="status">
    <span class="project-name" title={active.root}>{active.name}</span>
    <span class="project-env env-{environment?.status ?? "missing"}">{envLabel}</span>
    {#if environment?.status === "missing" || environment?.status === "error"}
      <button onclick={() => void handleSync()} disabled={syncBusy}>
        {syncBusy ? "Sincronizzazione…" : "Sincronizza"}
      </button>
    {/if}
    {#if saveLabel}<span class="project-save">{saveLabel}</span>{/if}
    {#if projectState.saveError}
      <span class="project-error" role="alert" title={projectState.saveError}>{projectState.saveError}</span>
    {/if}
    {#if projectState.catalogErrors.length > 0}
      <details class="project-catalog-errors">
        <summary>Diagnostica stereotipi ({projectState.catalogErrors.length})</summary>
        <ul>
          {#each projectState.catalogErrors as entry (entry.path)}
            <li><strong>{entry.path}</strong>: {entry.error}</li>
          {/each}
        </ul>
      </details>
    {/if}
    <button onclick={onOpenChooser} aria-label="Gestisci progetti">📁 Progetti</button>
    <button onclick={() => projectState.closeProject()} aria-label="Chiudi progetto attivo">✖</button>
  </div>
{:else if projectState.status === "error"}
  <div class="project-status project-status-error" role="alert">
    <span class="project-error">{projectState.statusMessage}</span>
    <button onclick={() => void projectState.restore()}>Riprova</button>
    <button onclick={onOpenChooser}>Progetti</button>
  </div>
{:else}
  <div class="project-status" role="status">
    <span>Nessun progetto attivo</span>
    <button onclick={onOpenChooser}>Apri progetti</button>
  </div>
{/if}
