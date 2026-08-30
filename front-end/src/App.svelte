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
  import ProjectStart from "./components/ProjectStart.svelte";
  import TrainingLogWindow from "./components/TrainingLogWindow.svelte";
  import type { ProjectWorkspaceSession } from "./project-workspace";
  import "@xyflow/svelte/dist/style.css";

  const trainingLogJobId = new URL(window.location.href).searchParams.get("training-log");
  let workspaceSession = $state<ProjectWorkspaceSession | null>(null);
  let workspaceError = $state<string | null>(null);

  function handleWorkspaceOpen(session: ProjectWorkspaceSession): void {
    workspaceError = null;
    workspaceSession = session;
  }

  function handleWorkspaceError(message: string): void {
    workspaceSession = null;
    workspaceError = message;
  }
</script>

{#if trainingLogJobId}
  <TrainingLogWindow jobId={trainingLogJobId} />
{:else}
  {#if workspaceSession}
    {#key workspaceSession.directory}
      <div
        style="height: 100vh; width: 100vw; overflow: hidden; background: #f8f8f8;"
      >
        <SvelteFlowProvider>
          <FlowCanvas session={workspaceSession} onInitializationError={handleWorkspaceError} />
        </SvelteFlowProvider>
      </div>
    {/key}
  {:else}
    <ProjectStart onOpen={handleWorkspaceOpen} initialError={workspaceError} />
  {/if}
{/if}
