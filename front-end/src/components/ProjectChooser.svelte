<!--
NNModelling — DSL for designing neural networks via visual node editor
Copyright (C) 2026  Luca Sforza

Licensed under the GNU General Public License v3 or later.
Commercial licenses are available — contact Luca Sforza.
See the LICENSE file for details.
-->

<script lang="ts">
  import { projectState } from "../projects/state.svelte";
  import type { ProjectApplyResult } from "../projects/state.svelte";
  import type { ProjectSummary } from "../projects/api";

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let activeTab = $state<"recent" | "create" | "open">("recent");
  let createName = $state("");
  let createRoot = $state("");
  let openRoot = $state("");
  let busy = $derived(projectState.busy);
  let paired = $derived(projectState.paired);

  async function handleCreate() {
    const result = await projectState.createProject(createName.trim() || null, createRoot.trim());
    if (result.ok) onClose();
    else if (result.error) createRoot = "";
  }

  async function handleOpen() {
    const result = await projectState.openProject(openRoot.trim());
    if (result.ok) onClose();
    else if (result.error) openRoot = "";
  }

  async function handleRecent(project: ProjectSummary) {
    const result: ProjectApplyResult = await projectState.openRecent(project);
    if (result.ok) onClose();
  }
</script>

<div class="project-chooser-backdrop" role="presentation">
  <div class="project-chooser" role="dialog" aria-modal="true" aria-label="Progetti">
    <header>
      <h2>Progetti</h2>
      <button class="close" onclick={onClose} aria-label="Chiudi">✖</button>
    </header>

    {#if projectState.status === "error" && projectState.statusMessage}
      <div class="project-message error" role="alert">{projectState.statusMessage}</div>
    {/if}
    {#if projectState.error}
      <div class="project-message error" role="alert">{projectState.error}</div>
    {/if}
    {#if !paired}
      <div class="project-message info" role="status">
        Il backend locale non è ancora associato: apri il pannello Training e collega il
        backend (es. http://127.0.0.1:8000) per creare o aprire progetti.
      </div>
    {/if}

    <div class="project-tabs" role="tablist" aria-label="Azioni progetto">
      <button class:active={activeTab === "recent"} onclick={() => (activeTab = "recent")} role="tab" aria-selected={activeTab === "recent"}>Recenti</button>
      <button class:active={activeTab === "create"} onclick={() => (activeTab = "create")} role="tab" aria-selected={activeTab === "create"}>Crea</button>
      <button class:active={activeTab === "open"} onclick={() => (activeTab = "open")} role="tab" aria-selected={activeTab === "open"}>Apri</button>
    </div>

    {#if activeTab === "recent"}
      {#if projectState.recent.length > 0}
        <ul class="recent-list">
          {#each projectState.recent as project (project.id)}
            <li>
              <button onclick={() => void handleRecent(project)} disabled={busy}>
                <strong>{project.name}</strong>
                <small>{project.root}</small>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="project-empty">Nessun progetto recente. Crea o apri un progetto per iniziare.</p>
      {/if}
    {:else if activeTab === "create"}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void handleCreate();
        }}
      >
        <label>Nome (facoltativo)
          <input bind:value={createName} placeholder="my-model" maxlength="80" />
        </label>
        <label>Percorso della cartella progetto
          <input bind:value={createRoot} placeholder="/home/me/projects/my-model" required autocomplete="off" />
        </label>
        <button type="submit" class="primary" disabled={busy || !createRoot.trim()}>
          {busy ? "Creazione…" : "Crea progetto"}
        </button>
      </form>
    {:else}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void handleOpen();
        }}
      >
        <label>Percorso del progetto esistente
          <input bind:value={openRoot} placeholder="/home/me/projects/my-model" required autocomplete="off" />
        </label>
        <button type="submit" class="primary" disabled={busy || !openRoot.trim()}>
          {busy ? "Apertura…" : "Apri progetto"}
        </button>
      </form>
    {/if}
  </div>
</div>
