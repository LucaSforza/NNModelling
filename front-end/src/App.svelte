<!--
NNModelling — DSL for designing neural networks via visual node editor
Copyright (C) 2026  Luca Sforza

Licensed under the GNU General Public License v3 or later.
Commercial licenses are available — contact Luca Sforza.
See the LICENSE file for details.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
-->

<script lang="ts">
  import { SvelteFlowProvider } from "@xyflow/svelte";
  import FlowCanvas from "./FlowCanvas.svelte";
  import ProjectChooser from "./components/ProjectChooser.svelte";
  import ProjectStatus from "./components/ProjectStatus.svelte";
  import TrainingLogWindow from "./components/TrainingLogWindow.svelte";
  import { projectState } from "./projects/state.svelte";
  import "@xyflow/svelte/dist/style.css";
  import "./styles/project.css";

  const trainingLogJobId = new URL(window.location.href).searchParams.get("training-log");

  // The chooser precedes the canvas while no project is active, but stays
  // dismissible so the user can reach the Training sidebar (pairing is the
  // prerequisite for project APIs). Once dismissed it only reappears when
  // reopened explicitly.
  let chooserOpen = $state(false);
  let chooserDismissed = $state(false);
  let showChooser = $derived(
    projectState.status === "ready" &&
      projectState.active === null &&
      !projectState.busy &&
      !chooserDismissed,
  );
  let effectiveChooser = $derived(showChooser || chooserOpen);

  function handleOpenChooser() {
    chooserDismissed = false;
    chooserOpen = true;
  }

  function handleCloseChooser() {
    chooserOpen = false;
    if (projectState.active === null && projectState.status === "ready") {
      chooserDismissed = true;
    }
  }
</script>

{#if trainingLogJobId}
  <TrainingLogWindow jobId={trainingLogJobId} />
{:else}
  <div
    style="height: 100vh; width: 100vw; overflow: hidden; background: #f8f8f8;"
  >
    <SvelteFlowProvider>
      <FlowCanvas onOpenProjectChooser={handleOpenChooser} />
      {#if effectiveChooser}
        <ProjectChooser onClose={handleCloseChooser} />
      {/if}
      <ProjectStatus onOpenChooser={handleOpenChooser} />
    </SvelteFlowProvider>
  </div>
{/if}
