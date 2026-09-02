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
  import { createPathProjectSession, type ProjectPathPayload } from "./project-workspace/path";
  import { BrowserRPCHandler, type ProjectRPCBridge } from "./sync/BrowserRPCHandler";
  import { TrainingController } from "./training/controller";
  import "@xyflow/svelte/dist/style.css";

  const trainingLogJobId = new URL(window.location.href).searchParams.get("training-log");
  let workspaceSession = $state<ProjectWorkspaceSession | null>(null);
  let workspaceError = $state<string | null>(null);
  let readyWaiter: { resolve: () => void; reject: (error: Error) => void; previous: ProjectWorkspaceSession | null } | undefined;

  const projectBridge: ProjectRPCBridge = {
    create: (payload) => activatePathProject(payload),
    open: (payload) => activatePathProject(payload),
  };
  const trainingController = new TrainingController();
  const rpcHandler = new BrowserRPCHandler(undefined, undefined, undefined, trainingController, projectBridge);
  rpcHandler.connect();

  function handleWorkspaceOpen(session: ProjectWorkspaceSession): void {
    workspaceError = null;
    workspaceSession = session;
  }

  function handleWorkspaceError(message: string): void {
    const waiter = readyWaiter;
    readyWaiter = undefined;
    if (waiter) {
      workspaceSession = waiter.previous;
      waiter.reject(new Error(message));
    } else {
      workspaceSession = null;
    }
    workspaceError = message;
  }

  async function activatePathProject(payload: ProjectPathPayload): Promise<Record<string, unknown>> {
    const previous = workspaceSession;
    const session = createPathProjectSession(payload, async (modelJson) => {
      // BrowserRPCHandler sends this notification through the same selected
      // connection; the MCP owner persists it to the already validated path.
      rpcHandler.notify("project_save", { projectPath: payload.projectPath, modelJson });
    });
    workspaceError = null;
    readyWaiter = { previous, resolve: () => undefined, reject: () => undefined };
    const ready = new Promise<void>((resolve, reject) => {
      readyWaiter = { previous, resolve, reject };
    });
    workspaceSession = session;
    try {
      await ready;
      const manifest = JSON.parse(payload.modelJson).manifest as { id: string; version: string; name: string };
      return { status: "ok", project: { id: manifest.id, version: manifest.version, name: manifest.name }, resourceCount: Object.keys(payload.resources).length };
    } catch (error) {
      workspaceSession = previous;
      throw error;
    } finally {
      if (readyWaiter?.previous === previous) readyWaiter = undefined;
    }
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
          <FlowCanvas session={workspaceSession} rpcHandler={rpcHandler} {trainingController} onSessionReady={() => readyWaiter?.resolve()} onInitializationError={handleWorkspaceError} />
        </SvelteFlowProvider>
      </div>
    {/key}
  {:else}
    <ProjectStart onOpen={handleWorkspaceOpen} initialError={workspaceError} />
  {/if}
{/if}
