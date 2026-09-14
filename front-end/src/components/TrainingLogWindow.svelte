<script lang="ts">
  import { onMount } from "svelte";
  import { TrainingApiClient, type TrainingJobStatus } from "../training/api";
  import { loadBackendConnection } from "../training/connection";
  import LanguageSwitcher from "./LanguageSwitcher.svelte";
  import { useI18n } from "../i18n.svelte";

  interface Props {
    jobId: string;
  }

  let { jobId }: Props = $props();
  const { t } = useI18n();
  let stdout = $state("");
  let stderr = $state("");
  let status = $state<TrainingJobStatus["status"] | null>(null);
  let errorMessage = $state("");
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let stopped = false;

  onMount(() => {
    const connection = loadBackendConnection();
    if (!connection) {
      errorMessage = "No backend connection is available in this browser.";
      return;
    }
    const api = new TrainingApiClient(connection.baseUrl, connection.token);

    async function poll(): Promise<void> {
      if (stopped) return;
      try {
        const [job, tail] = await Promise.all([
          api.getTrainingJob(jobId),
          api.tailTrainingJobLogs(jobId, stdoutOffset, stderrOffset),
        ]);
        status = job.status;
        stdout = tail.stdout.reset ? tail.stdout.text : stdout + tail.stdout.text;
        stderr = tail.stderr.reset ? tail.stderr.text : stderr + tail.stderr.text;
        stdoutOffset = tail.stdout.offset;
        stderrOffset = tail.stderr.offset;
        if (!["succeeded", "failed", "cancelled"].includes(job.status)) {
          window.setTimeout(() => void poll(), 750);
        }
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : "Training log cannot be read for this job.";
      }
    }

    void poll();
    return () => {
      stopped = true;
    };
  });
</script>

<main>
  <header>
    <div>
      <h1>{t("Training log")}</h1>
      <p>{jobId}</p>
    </div>
    <strong>{status ? t(status[0].toUpperCase() + status.slice(1)) : t("connection…")}</strong>
  </header>

  <LanguageSwitcher placement="editor" />

  {#if errorMessage}
    <p class="error">{t(errorMessage)}</p>
  {:else}
    <section>
      <h2>stdout</h2>
      <pre>{stdout || t("Waiting for output…")}</pre>
    </section>
    <section>
      <h2>stderr</h2>
      <pre class:error-output={stderr.length > 0}>{stderr || t("No errors.")}</pre>
    </section>
  {/if}
</main>

<style>
  :global(body) { margin: 0; background: #111827; color: #e5e7eb; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { padding: 18px; }
  header { display: flex; align-items: start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
  h1, h2, p { margin: 0; }
  h1 { font-size: 1.25rem; }
  h2 { margin-bottom: 8px; color: #93c5fd; font-size: 1rem; }
  header p { color: #9ca3af; font-size: .8rem; overflow-wrap: anywhere; }
  header strong { color: #86efac; text-transform: uppercase; }
  section + section { margin-top: 18px; }
  pre { min-height: 120px; max-height: 42vh; margin: 0; overflow: auto; padding: 12px; border: 1px solid #374151; border-radius: 6px; background: #030712; white-space: pre-wrap; overflow-wrap: anywhere; }
  .error-output, .error { color: #fca5a5; }
</style>
