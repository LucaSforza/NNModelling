<script lang="ts">
  import { onMount } from "svelte";
  import type { Diagram } from "../Diagram.svelte";
  import {
    BackendApiError,
    TrainingApiClient,
    canonicalDatasetParameters,
    canCancelTrainingJob,
    type DatasetInfo,
    type DatasetParameter,
    type PairingGrant,
    type TrainingJobLogs,
    type TrainingJobRequest,
    type TrainingJobStatus,
  } from "../training/api";
  import { TrainingController, type TrainingControllerSnapshot } from "../training/controller";
  import { trainingLogWindowUrl } from "../training/windows";
  import { RefreshGate } from "../training/refreshGate";
  import { buildPackageBundle } from "../training/package-bundle";

  interface Props {
    diagram: Diagram;
    controller: TrainingController;
    onClose: () => void;
  }

  type ConnectionState =
    | "disconnected"
    | "checking"
    | "pending"
    | "active"
    | "expired"
    | "rejected"
    | "error";

  let { diagram, controller, onClose }: Props = $props();

  let datasets = $state.raw<DatasetInfo[]>([]);
  let jobs = $state.raw<TrainingJobStatus[]>([]);
  let selectedJobLogs = $state.raw<TrainingJobLogs | null>(null);
  let backendUrl = $state(
    (import.meta.env.VITE_TRAINING_API_URL as string | undefined) ?? "http://127.0.0.1:8000",
  );
  let deviceName = $state("");
  let connectionState = $state<ConnectionState>("disconnected");
  let session = $state.raw<{ expires_at: string | null; device_name: string | null } | null>(null);
  let pairing = $state.raw<PairingGrant | null>(null);
  let selectedDataset = $state("");
  let datasetParams = $state<Record<string, string>>({});
  let maxEpochs = $state("20");
  let learningRate = $state("0.001");
  let optimizerTarget = $state("torch.optim.Adam");
  let accelerator = $state<"auto" | "cpu" | "cuda">("auto");
  let patience = $state("3");
  let minDelta = $state("0");
  let seed = $state("42");
  let wandbProject = $state("NeuralNetworks");
  let wandbMode = $state<"disabled" | "offline" | "online">("disabled");
  let cpu = $state("4");
  let memoryGb = $state("8");
  let gpu = $state("0");
  let gpuMemoryGb = $state("");
  let gpuType = $state("");
  let node = $state("");
  let priority = $state("0");
  let packageSuffix = $state("");
  let selectedJobId = $state<string | null>(null);
  let loading = $state(false);
  let loadingJobs = $state(false);
  let loadingLogs = $state(false);
  let errorMessage = $state("");
  let successMessage = $state("");
  let api: TrainingApiClient | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let eventAbort: AbortController | null = null;
  let refreshGate = new RefreshGate();

  let selectedDatasetInfo = $derived(
    datasets.find((dataset) => dataset.target === selectedDataset) ?? null,
  );

  onMount(() => {
    const unsubscribe = controller.subscribe(applyControllerSnapshot);
    void controller.restore();
    return () => {
      unsubscribe();
      eventAbort?.abort();
      eventAbort = null;
    };
  });

  function cleanup() {
    refreshGate.invalidate();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    eventAbort?.abort();
    eventAbort = null;
  }

  function applyControllerSnapshot(snapshot: TrainingControllerSnapshot): void {
    const wasActive = connectionState === "active";
    const view = snapshot.connection;
    connectionState = view.status;
    backendUrl = view.baseUrl ?? backendUrl;
    deviceName = view.deviceName ?? "";
    session = view.sessionExpiresAt ? { device_name: view.deviceName, expires_at: view.sessionExpiresAt } : null;
    pairing = view.requestId && view.verificationCode ? {
      request_id: view.requestId, connection_id: view.connectionId ?? "", token: "", verification_code: view.verificationCode, expires_at: view.expiresAt ?? "",
    } : null;
    datasets = snapshot.datasets;
    api = view.status === "active" ? controller.getApi() : null;
    errorMessage = view.error ?? "";
    const config = snapshot.config;
    selectedDataset = config.selectedDataset;
    datasetParams = Object.fromEntries(Object.entries(config.datasetParams).map(([key, value]) => [key, String(value ?? "")]));
    seed = String(config.seed); optimizerTarget = config.optimizerTarget; learningRate = String(config.learningRate);
    maxEpochs = String(config.maxEpochs); accelerator = config.accelerator; patience = String(config.patience); minDelta = String(config.minDelta);
    wandbProject = config.wandbProject; wandbMode = config.wandbMode; cpu = String(config.cpu); memoryGb = String(config.memoryGb); gpu = String(config.gpu);
    gpuMemoryGb = config.gpuMemoryGb === undefined ? "" : String(config.gpuMemoryGb); gpuType = config.gpuType ?? ""; node = config.node ?? "";
    priority = String(config.priority); packageSuffix = config.packageSuffix ?? "";
    if (view.status === "active" && !wasActive) {
      void loadDatasets();
      void refreshJobs();
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => void refreshJobs(), 3000);
    } else if (view.status !== "active" && wasActive) {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  }

  async function connect() {
    errorMessage = "";
    successMessage = "";
    try {
      await controller.connect(backendUrl, deviceName);
    } catch (error) {
      connectionState = "error";
      errorMessage = errorText(error);
    }
  }

  async function renew() {
    errorMessage = "";
    try {
      await controller.renew();
    } catch (error) {
      handleConnectionError(error);
    }
  }

  function forget() {
    void controller.disconnect(false);
  }

  async function revokeAndForget() {
    if (!api || !confirm("Revocare questa connessione sul backend?")) return;
    try {
      await controller.disconnect(true);
    } catch (error) {
      errorMessage = errorText(error);
    }
  }

  async function loadDatasets() {
    datasets = controller.getDatasets();
    if (!selectedDataset && datasets.length > 0) selectDataset(datasets[0]);
  }

  async function refreshJobs() {
    if (connectionState !== "active") return;
    const request = refreshGate.begin();
    loadingJobs = true;
    try {
      const nextJobs = await requireApi().listTrainingJobs();
      if (request.isCurrent()) jobs = nextJobs;
    } catch (error) {
      if (request.isCurrent()) handleConnectionError(error);
    } finally {
      if (request.isCurrent()) loadingJobs = false;
    }
  }

  function selectDataset(dataset: DatasetInfo) {
    selectedDataset = dataset.target;
    const defaults = Object.fromEntries(dataset.parameters.map((parameter) => [parameter.name, parameter.default]));
    datasetParams = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, String(value ?? "")]));
    try { controller.updateConfig({ selectedDataset, datasetParams: defaults }); } catch (error) { handleConnectionError(error); }
  }

  function setDatasetParameter(parameter: DatasetParameter, event: Event) {
    const value = (event.currentTarget as HTMLInputElement).value;
    datasetParams = { ...datasetParams, [parameter.name]: value };
    syncConfigFromDraft();
  }

  $effect(() => {
    if (connectionState === "active") syncConfigFromDraft();
  });

  function syncConfigFromDraft(): void {
    const typedDatasetParams = Object.fromEntries(
      Object.entries(datasetParams).map(([key, value]) => {
        const parameter = selectedDatasetInfo?.parameters.find((candidate) => candidate.name === key);
        return [key, parameter ? coerce(value, parameter.type) : value];
      }),
    );
    try {
      controller.updateConfig({ selectedDataset, datasetParams: typedDatasetParams, seed: coerce(seed, "int"), optimizerTarget,
        learningRate: coerce(learningRate, "float"), maxEpochs: coerce(maxEpochs, "int"), accelerator,
        patience: coerce(patience, "int"), minDelta: coerce(minDelta, "float"), wandbProject, wandbMode,
        cpu: coerce(cpu, "int"), memoryGb: coerce(memoryGb, "float"), gpu: coerce(gpu, "int"),
        gpuMemoryGb: gpuMemoryGb ? coerce(gpuMemoryGb, "float") : undefined, gpuType: gpuType || undefined,
        node: node || undefined, priority: coerce(priority, "int"), packageSuffix: packageSuffix || undefined });
    } catch {
      // Text inputs can be temporarily incomplete; submit/MCP validation reports the error.
    }
  }

  function coerce(value: string, type: "int"): number;
  function coerce(value: string, type: "float"): number;
  function coerce(value: string, type: "bool"): boolean;
  function coerce(value: string, type: string): number | boolean | string;
  function coerce(value: string, type: string): number | boolean | string {
    if (type === "int") return Number.parseInt(value, 10);
    if (type === "float") return Number.parseFloat(value);
    if (type === "bool") return value === "true";
    return value;
  }

  async function buildRequest(): Promise<TrainingJobRequest> {
    const config = controller.getConfig();
    if (!config.selectedDataset) throw new Error("Seleziona un dataset prima di accodare il training");
    await diagram.waitForPackageRuntime();
    const bundle = await buildPackageBundle(diagram.nodes, diagram.edges, diagram.packageExports(), diagram.typeResult);
    const uploaded = await requireApi().uploadPackageBundle(bundle);
    return {
      schema_version: 1,
      network: { format: "package", value: { bundle_ref: uploaded.bundle_ref, graph: bundle.graph } },
      training: {
        dataset: {
          target: config.selectedDataset,
          parameters: selectedDatasetInfo
            ? canonicalDatasetParameters(selectedDatasetInfo, Object.fromEntries(Object.entries(config.datasetParams).map(([key, value]) => [key, String(value)])))
            : {},
        },
        seed: config.seed,
        optimizer: { target: config.optimizerTarget, learning_rate: config.learningRate },
        trainer: {
          max_epochs: config.maxEpochs,
          accelerator: config.accelerator,
          patience: config.patience,
          min_delta: config.minDelta,
        },
        wandb: { project: config.wandbProject, mode: config.wandbMode },
      },
      resources: {
        cpu: config.cpu, memory_gb: config.memoryGb, gpu: config.gpu,
        ...(config.gpuMemoryGb !== undefined ? { gpu_memory_gb: config.gpuMemoryGb } : {}),
        ...(config.gpuType ? { gpu_type: config.gpuType } : {}),
        ...(config.node ? { node: config.node } : {}),
      },
      priority: config.priority,
      ...(config.packageSuffix ? { package_name: `nnm_${config.packageSuffix}` } : {}),
    };
  }

  async function submit() {
    loading = true;
    errorMessage = "";
    successMessage = "";
    const logWindow = openWaitingWindow("Preparazione del terminale del training…");
    const wandbWindow = wandbMode === "online"
      ? openWaitingWindow("In attesa che W&B inizializzi la run…")
      : null;
    try {
      const job = await requireApi().submitTrainingJob(await buildRequest());
      successMessage = `Job ${job.id} accodato.`;
      selectedJobId = job.id;
      openLogWindow(job.id, logWindow);
      startEvents(job.id, (wandbUrl) => openWandbWindow(wandbWindow, wandbUrl));
      await loadJobLogs(job.id);
      await refreshJobs();
    } catch (error) {
      logWindow?.close();
      wandbWindow?.close();
      handleConnectionError(error);
    } finally {
      loading = false;
    }
  }

  function startEvents(jobId: string, onWandbReady?: (url: string) => void) {
    eventAbort?.abort();
    eventAbort = new AbortController();
    void requireApi().subscribeTrainingEvents(
      jobId,
      (event) => {
        if (event.type === "wandb_ready" && typeof event.wandb_url === "string") {
          onWandbReady?.(event.wandb_url);
        }
        void refreshJobs();
      },
      eventAbort.signal,
    ).catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) handleConnectionError(error);
    });
  }

  async function loadJobLogs(jobId: string) {
    loadingLogs = true;
    try {
      selectedJobLogs = await requireApi().getTrainingJobLogs(jobId);
    } catch (error) {
      handleConnectionError(error);
    } finally {
      loadingLogs = false;
    }
  }

  function selectJob(jobId: string) {
    selectedJobId = jobId;
    selectedJobLogs = null;
    startEvents(jobId);
    void loadJobLogs(jobId);
  }

  async function cancel(jobId: string) {
    try {
      await requireApi().cancelTrainingJob(jobId);
      await refreshJobs();
    } catch (error) {
      handleConnectionError(error);
    }
  }

  function openWandb(job: TrainingJobStatus) {
    if (job.wandb_url) window.open(job.wandb_url, "_blank", "noopener,noreferrer");
  }

  function openWaitingWindow(message: string): Window | null {
    const popup = window.open("", "_blank");
    if (!popup) return null;
    popup.opener = null;
    popup.document.title = "NNModelling training";
    popup.document.body.textContent = message;
    return popup;
  }

  function openLogWindow(jobId: string, popup: Window | null = null) {
    const target = popup ?? window.open("", "_blank");
    if (target) target.location.href = trainingLogWindowUrl(window.location.href, jobId);
  }

  function openWandbWindow(popup: Window | null, wandbUrl: string) {
    if (popup && !popup.closed) {
      popup.location.replace(wandbUrl);
    } else {
      window.open(wandbUrl, "_blank", "noopener,noreferrer");
    }
  }

  async function downloadModelPackage(job: TrainingJobStatus) {
    if (!job.model_package) return;
    try {
      const blob = await requireApi().downloadModelPackage(job.id, job.model_package.sha256);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = job.model_package.wheel.split("/").at(-1) ?? "model.whl";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      handleConnectionError(error);
    }
  }

  function requireApi(): TrainingApiClient {
    if (!api) throw new Error("Collega prima un backend");
    return api;
  }

  function handleConnectionError(error: unknown) {
    if (error instanceof BackendApiError && error.code === "session_expired") {
      connectionState = "expired";
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = undefined;
    } else if (error instanceof BackendApiError && error.code === "session_revoked") {
      connectionState = "rejected";
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    errorMessage = errorText(error);
  }

  function errorText(error: unknown): string {
    if (error instanceof TypeError) return "Backend irraggiungibile o Origin CORS non autorizzata";
    return error instanceof Error ? error.message : String(error);
  }

  function formatExpiry(value: string | null | undefined): string {
    return value ? new Date(value).toLocaleString() : "non disponibile";
  }
</script>

<aside class="training-sidebar">
  <header>
    <h2>Training</h2>
    <button class="close" onclick={onClose} aria-label="Chiudi training">✖</button>
  </header>

  {#if errorMessage}<div class="message error" role="alert">{errorMessage}</div>{/if}
  {#if successMessage}<div class="message success">{successMessage}</div>{/if}

  <section class="connection">
    <h3>Backend</h3>
    {#if connectionState === "active"}
      <div class="connection-summary">
        <strong>Connesso</strong>
        <span>{backendUrl}</span>
        <small>{session?.device_name ?? "Dispositivo senza nome"}</small>
        <small>Scade: {formatExpiry(session?.expires_at)}</small>
      </div>
      <div class="actions">
        <button onclick={forget}>Dimentica su questo browser</button>
        <button class="danger" onclick={revokeAndForget}>Disconnetti e revoca</button>
      </div>
    {:else if connectionState === "pending" && pairing}
      <p>Richiesta in attesa di approvazione sulla macchina backend.</p>
      <div class="verification-code" aria-label="Codice di associazione">
        {pairing.verification_code}
      </div>
      <small>Esegui <code>just pairing-pending</code> e verifica questo codice.</small>
      <button onclick={forget}>Annulla e dimentica</button>
    {:else if connectionState === "checking"}
      <p>Verifica della connessione…</p>
    {:else}
      {#if connectionState === "expired"}
        <p>La connessione è scaduta e richiede una nuova approvazione.</p>
        <div class="actions">
          <button class="primary" onclick={renew}>Richiedi rinnovo</button>
          <button onclick={forget}>Dimentica</button>
        </div>
      {:else}
        {#if connectionState === "rejected"}<p>La richiesta è stata rifiutata o revocata.</p>{/if}
        <label>URL backend
          <input bind:value={backendUrl} placeholder="http://192.168.1.20:8000" />
        </label>
        <label>Nome dispositivo (facoltativo)
          <input bind:value={deviceName} placeholder="Portatile laboratorio" maxlength="80" />
        </label>
        <button class="primary" onclick={connect}>Richiedi connessione</button>
      {/if}
    {/if}
  </section>

  {#if connectionState === "active"}
    <section>
      <h3>Dataset</h3>
      <label>Classe Python
        <select value={selectedDataset} onchange={(event) => {
          const target = datasets.find((item) => item.target === (event.currentTarget as HTMLSelectElement).value);
          if (target) selectDataset(target);
        }}>
          {#each datasets as dataset (dataset.target)}
            <option value={dataset.target}>{dataset.name}</option>
          {/each}
        </select>
      </label>
      {#if selectedDatasetInfo}
        {#if selectedDatasetInfo.num_classes !== null}
          <small>Classi rilevate dal dataset: {selectedDatasetInfo.num_classes}</small>
        {/if}
        {#each selectedDatasetInfo.parameters as parameter (parameter.name)}
          <label>{parameter.name}
            <input value={datasetParams[parameter.name] ?? ""} oninput={(event) => setDatasetParameter(parameter, event)} />
          </label>
        {/each}
      {/if}
      <label>Seed<input type="number" bind:value={seed} /></label>
    </section>

    <section>
      <h3>Ottimizzazione</h3>
      <label>Optimizer target<input bind:value={optimizerTarget} /></label>
      <div class="grid">
        <label>Learning rate<input type="number" step="0.0001" bind:value={learningRate} /></label>
        <label>Epochs<input type="number" bind:value={maxEpochs} /></label>
        <label>Accelerator<input bind:value={accelerator} /></label>
        <label>Patience<input type="number" bind:value={patience} /></label>
        <label>Min delta<input type="number" step="0.001" bind:value={minDelta} /></label>
      </div>
    </section>

    <section>
      <h3>W&B</h3>
      <div class="grid">
        <label>Project<input bind:value={wandbProject} /></label>
        <label>Mode<input bind:value={wandbMode} /></label>
      </div>
    </section>

    <section>
      <h3>Risorse e priorità</h3>
      <div class="grid">
        <label>CPU<input type="number" bind:value={cpu} /></label>
        <label>RAM GB<input type="number" bind:value={memoryGb} /></label>
        <label>GPU<input type="number" bind:value={gpu} /></label>
        <label>GPU RAM GB<input type="number" bind:value={gpuMemoryGb} /></label>
      </div>
      <label>Tipo GPU<input bind:value={gpuType} placeholder="A100" /></label>
      <label>Nodo<input bind:value={node} placeholder="qualsiasi" /></label>
      <label>Priorità<input type="number" bind:value={priority} /></label>
      <label>Nome pacchetto
        <input bind:value={packageSuffix} placeholder="mnist_classifier" pattern="[A-Za-z][A-Za-z0-9_]*" />
        <small>La wheel e l'import avranno il prefisso <code>nnm_</code>.</small>
      </label>
      <button class="submit" onclick={submit} disabled={loading}>{loading ? "Invio..." : "Invia training"}</button>
    </section>

    <section class="jobs">
      <h3>Job {#if loadingJobs}…{/if}</h3>
      {#each jobs as job (job.id)}
        <article class:selected={selectedJobId === job.id}>
          <button class="job-title" onclick={() => selectJob(job.id)}>
            <span>{job.id.slice(0, 8)}</span><strong>{job.status}</strong>
          </button>
          <small>priorità {job.priority} · {job.executor ?? "in coda"}</small>
          {#if job.error}<pre>{job.error}</pre>{/if}
          {#if canCancelTrainingJob(job.status)}<button onclick={() => cancel(job.id)}>Annulla</button>{/if}
          {#if job.wandb_url}<button onclick={() => openWandb(job)}>Apri W&B</button>{/if}
          <button onclick={() => openLogWindow(job.id)}>Apri terminale</button>
          {#if job.model_package}
            <button onclick={() => void downloadModelPackage(job)}>Scarica wheel</button>
          {:else if job.package_error}
            <small>Export wheel non riuscito: {job.package_error}</small>
          {/if}
          {#if selectedJobId === job.id}
            <button onclick={() => void loadJobLogs(job.id)} disabled={loadingLogs}>
              {loadingLogs ? "Caricamento log..." : "Aggiorna log"}
            </button>
            {#if selectedJobLogs}
              <details open>
                <summary>Log job</summary>
                {#if selectedJobLogs.stdout}<pre>{selectedJobLogs.stdout}</pre>{/if}
                {#if selectedJobLogs.stderr}<pre>{selectedJobLogs.stderr}</pre>{/if}
                {#if !selectedJobLogs.stdout && !selectedJobLogs.stderr}<small>Nessun log disponibile.</small>{/if}
              </details>
            {/if}
          {/if}
        </article>
      {:else}
        <p>Nessun job.</p>
      {/each}
    </section>
  {/if}
</aside>

<style>
  .training-sidebar { position: fixed; z-index: 20; top: 0; right: 0; bottom: 0; width: min(410px, 100vw); overflow-y: auto; padding: 18px; background: #fff; box-shadow: -4px 0 18px #0002; font-family: sans-serif; }
  header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #ddd; margin-bottom: 12px; }
  h2, h3 { margin: 0 0 10px; } h3 { font-size: 1rem; }
  section { border-bottom: 1px solid #e5e7eb; padding: 12px 0; }
  label { display: flex; flex-direction: column; gap: 4px; margin: 7px 0; font-size: .82rem; }
  input, select { box-sizing: border-box; width: 100%; padding: 6px; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; } .grid label { margin: 0; }
  button { padding: 6px 9px; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; cursor: pointer; }
  button:hover { background: #e2e8f0; } button:disabled { cursor: wait; opacity: .6; }
  .close { border: 0; background: transparent; font-size: 1.1rem; }
  .primary, .submit { width: 100%; margin-top: 8px; background: #2563eb; color: white; border-color: #2563eb; }
  .danger { color: #991b1b; border-color: #fecaca; background: #fff1f2; }
  .message { padding: 8px; border-radius: 4px; margin-bottom: 8px; font-size: .82rem; } .error { color: #991b1b; background: #fee2e2; } .success { color: #166534; background: #dcfce7; }
  .connection-summary { display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }
  .connection-summary strong { color: #166534; }
  .actions { display: flex; gap: 6px; margin-top: 9px; } .actions button { flex: 1; }
  .verification-code { margin: 10px 0; padding: 12px; border: 2px dashed #2563eb; border-radius: 6px; text-align: center; font: 700 1.8rem monospace; letter-spacing: .25rem; }
  code { font-size: .75rem; }
  article { margin: 7px 0; padding: 8px; border: 1px solid #e2e8f0; border-radius: 5px; } article.selected { border-color: #2563eb; }
  .job-title { width: 100%; display: flex; justify-content: space-between; } small { color: #64748b; } pre { max-height: 100px; overflow: auto; white-space: pre-wrap; color: #991b1b; font-size: .72rem; }
</style>
