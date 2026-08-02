<script lang="ts">
  import { onMount } from "svelte";
  import type { Diagram } from "../Diagram.svelte";
  import { NNTree } from "../conversion/nnTree";
  import {
    BackendApiError,
    TrainingApiClient,
    buildTrainingRequest,
    canCancelTrainingJob,
    type DatasetInfo,
    type DatasetParameter,
    type PairingGrant,
    type SessionInfo,
    type TrainingJobLogs,
    type TrainingJobRequest,
    type TrainingJobStatus,
  } from "../training/api";
  import {
    forgetBackendConnection,
    loadBackendConnection,
    normalizeBackendUrl,
    saveBackendConnection,
    type SavedBackendConnection,
  } from "../training/connection";
  import { projectState, isLocalCompanionBackend } from "../projects/state.svelte";
  import { trainingLogWindowUrl } from "../training/windows";
  import { RefreshGate } from "../training/refreshGate";

  interface Props {
    diagram: Diagram;
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

  let { diagram, onClose }: Props = $props();

  let datasets = $state.raw<DatasetInfo[]>([]);
  let datasetCatalogErrors = $state.raw<{ path: string; error: string }[]>([]);
  let jobs = $state.raw<TrainingJobStatus[]>([]);
  let selectedJobLogs = $state.raw<TrainingJobLogs | null>(null);
  let backendUrl = $state(
    (import.meta.env.VITE_TRAINING_API_URL as string | undefined) ?? "http://127.0.0.1:8000",
  );
  let deviceName = $state("");
  let connectionState = $state<ConnectionState>("disconnected");
  let session = $state.raw<SessionInfo | null>(null);
  let pairing = $state.raw<PairingGrant | null>(null);
  let selectedDataset = $state("");
  let datasetParams = $state<Record<string, string>>({});
  let maxEpochs = $state("20");
  let learningRate = $state("0.001");
  let batchSize = $state("32");
  let numWorkers = $state("4");
  let trainSize = $state("0.8");
  let optimizerTarget = $state("torch.optim.Adam");
  let accelerator = $state("auto");
  let patience = $state("3");
  let minDelta = $state("0");
  let seed = $state("42");
  let wandbProject = $state("NeuralNetworks");
  let wandbMode = $state("online");
  let wandbEntity = $state("");
  let wandbTags = $state("");
  let wandbRunName = $state("");
  let wandbApiKey = $state("");
  let wandbKeyConfigured = $state(false);
  let loadedWandbProjectId = $state<string | null>(null);
  let overridesText = $state("");
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
  let savedConnection: SavedBackendConnection | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let pairingTimer: ReturnType<typeof setInterval> | undefined;
  let eventAbort: AbortController | null = null;
  let refreshGate = new RefreshGate();
  let datasetLoadSeq = 0;

  let selectedDatasetInfo = $derived(
    datasets.find((dataset) => dataset.target === selectedDataset) ?? null,
  );

  // Project-aware training: the job carries project_id only when the connected
  // backend is the local companion (project registry owner). A remote backend
  // keeps the unchanged non-project contract.
  let localCompanion = $derived(isLocalCompanionBackend(backendUrl));
  let activeProject = $derived(projectState.active);
  let projectJob = $derived(activeProject !== null && localCompanion);
  let projectEnv = $derived(projectJob ? activeProject!.environment : null);
  let projectEnvReady = $derived(!projectJob || projectEnv?.status === "ready");
  let projectEnvMessage = $derived(
    projectEnv?.status === "error" && projectEnv.message
      ? projectEnv.message
      : projectEnv?.status === "missing"
        ? "L'ambiente del progetto non è ancora sincronizzato (manca il venv)."
        : "",
  );

  // W&B non-secret fields reload whenever the active project changes.
  $effect(() => {
    const project = projectState.active;
    if (!project) {
      loadedWandbProjectId = null;
      return;
    }
    if (project.id === loadedWandbProjectId) return;
    loadedWandbProjectId = project.id;
    wandbProject = project.wandb.project;
    wandbMode = project.wandb.mode;
    wandbEntity = project.wandb.entity;
    wandbTags = project.wandb.tags.join(", ");
    wandbRunName = project.wandb.run_name_template;
    wandbKeyConfigured = project.api_key_configured;
  });

  onMount(() => {
    void restoreConnection();
    return cleanup;
  });

  function cleanup() {
    refreshGate.invalidate();
    if (refreshTimer) clearInterval(refreshTimer);
    if (pairingTimer) clearInterval(pairingTimer);
    refreshTimer = undefined;
    pairingTimer = undefined;
    eventAbort?.abort();
    eventAbort = null;
  }

  async function restoreConnection() {
    const restored = loadBackendConnection();
    if (!restored) return;
    savedConnection = restored;
    backendUrl = restored.baseUrl;
    deviceName = restored.deviceName ?? "";
    api = new TrainingApiClient(restored.baseUrl, restored.token);
    connectionState = "checking";
    try {
      if (restored.requestId) {
        pairing = {
          request_id: restored.requestId,
          connection_id: restored.connectionId,
          token: restored.token,
          verification_code: restored.verificationCode ?? "",
          expires_at: "",
        };
        const restoredState = await checkPairing();
        if (restoredState === "pending") startPairingTimer();
      } else {
        await activate(await api.getSession());
      }
    } catch (error) {
      handleConnectionError(error);
    }
  }

  async function connect() {
    cleanup();
    errorMessage = "";
    successMessage = "";
    connectionState = "checking";
    try {
      const normalized = normalizeBackendUrl(backendUrl);
      const publicApi = new TrainingApiClient(normalized);
      await publicApi.health();
      const grant = await publicApi.createPairing(deviceName.trim() || null);
      backendUrl = normalized;
      pairing = grant;
      savedConnection = connectionFromGrant(grant);
      saveBackendConnection(savedConnection);
      api = new TrainingApiClient(normalized, grant.token);
      connectionState = "pending";
      startPairingTimer();
    } catch (error) {
      connectionState = "error";
      errorMessage = errorText(error);
    }
  }

  async function renew() {
    if (!api || !savedConnection) return;
    errorMessage = "";
    connectionState = "checking";
    try {
      const grant = await api.createRenewal();
      pairing = grant;
      savedConnection = connectionFromGrant(grant);
      saveBackendConnection(savedConnection);
      connectionState = "pending";
      startPairingTimer();
    } catch (error) {
      handleConnectionError(error);
    }
  }

  function startPairingTimer() {
    if (pairingTimer) clearInterval(pairingTimer);
    pairingTimer = setInterval(() => void checkPairing(), 1500);
  }

  async function checkPairing(): Promise<ConnectionState> {
    if (!api || !pairing || !savedConnection) return connectionState;
    try {
      const status = await api.getPairingStatus(pairing.request_id);
      if (status.status === "approved") {
        if (pairingTimer) clearInterval(pairingTimer);
        pairingTimer = undefined;
        savedConnection = { ...savedConnection, requestId: null, verificationCode: null };
        saveBackendConnection(savedConnection);
        pairing = null;
        await activate(await api.getSession());
      } else if (status.status === "rejected" || status.status === "expired") {
        if (pairingTimer) clearInterval(pairingTimer);
        pairingTimer = undefined;
        connectionState = status.status === "rejected" ? "rejected" : "expired";
      } else {
        connectionState = "pending";
      }
    } catch (error) {
      handleConnectionError(error);
    }
    return connectionState;
  }

  async function activate(currentSession: SessionInfo) {
    refreshGate.invalidate();
    connectionState = "active";
    session = currentSession;
    errorMessage = "";
    await Promise.all([refreshJobs()]);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => void refreshJobs(), 3000);
    // Pairing is the prerequisite for the project workspace APIs: refresh the
    // recent/active project state now that a backend connection exists. The
    // dataset catalog effect reloads once the active project is resolved.
    void projectState.restore();
  }

  function forget() {
    cleanup();
    if (savedConnection) forgetBackendConnection(savedConnection.baseUrl);
    api = null;
    savedConnection = null;
    pairing = null;
    session = null;
    datasets = [];
    jobs = [];
    connectionState = "disconnected";
    errorMessage = "";
    successMessage = "";
  }

  async function revokeAndForget() {
    if (!api || !confirm("Revocare questa connessione sul backend?")) return;
    try {
      await api.revokeSession();
    } catch (error) {
      errorMessage = errorText(error);
    } finally {
      forget();
    }
  }

  async function loadDatasets() {
    // A sequence guard keeps the freshest catalog: the installed-only fetch
    // issued at activate time must never overwrite the project catalog that
    // resolves after restore() completes.
    const seq = ++datasetLoadSeq;
    try {
      if (projectJob) {
        // Local companion + active project: the project catalog already
        // includes installed classes, so it fully replaces the plain list.
        const catalog = await projectState.loadProjectDatasets();
        if (catalog) {
          if (seq !== datasetLoadSeq) return;
          datasets = catalog.datasets;
          datasetCatalogErrors = catalog.errors;
          settleDatasetSelection();
          return;
        }
        // Project catalog unavailable (restore in flight or failure): keep the
        // actionable workspace error and fall through to installed classes.
        if (seq !== datasetLoadSeq) return;
        if (projectState.error) errorMessage = projectState.error;
      }
      const installed = await requireApi().listDatasets();
      if (seq !== datasetLoadSeq) return;
      datasetCatalogErrors = [];
      datasets = installed;
      settleDatasetSelection();
    } catch (error) {
      if (seq === datasetLoadSeq) handleConnectionError(error);
    }
  }

  // After a catalog swap, keep a still-valid selection and fall back to the
  // first dataset when the previous target no longer exists (project switch).
  function settleDatasetSelection() {
    if (!selectedDataset || !datasets.some((dataset) => dataset.target === selectedDataset)) {
      if (datasets.length > 0) selectDataset(datasets[0]);
    }
  }

  // Reload the dataset catalog whenever the project context changes so
  // project-local classes become selectable without a re-pair: restore()
  // resolves asynchronously after activate(), and open/close changes the
  // active project id. Only the sync reads (projectJob, connectionState)
  // are tracked, so the reload never loops on its own writes.
  $effect(() => {
    if (connectionState === "active") {
      void loadDatasets();
    }
  });

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
    datasetParams = Object.fromEntries(
      dataset.parameters.map((parameter) => [parameter.name, String(parameter.default ?? "")]),
    );
  }

  function setDatasetParameter(parameter: DatasetParameter, event: Event) {
    const value = (event.currentTarget as HTMLInputElement).value;
    datasetParams = { ...datasetParams, [parameter.name]: value };
  }

  function coerce(value: string, type: string): unknown {
    if (type === "int") return Number.parseInt(value, 10);
    if (type === "float") return Number.parseFloat(value);
    if (type === "bool") return value === "true";
    return value;
  }

  function buildRequest(): TrainingJobRequest {
    if (!selectedDatasetInfo) throw new Error("Seleziona un dataset");
    const normalizedPackageSuffix = packageSuffix.trim();
    if (normalizedPackageSuffix && !/^[A-Za-z][A-Za-z0-9_]*$/.test(normalizedPackageSuffix)) {
      throw new Error("Il nome del pacchetto può contenere solo lettere, numeri e _ e deve iniziare con una lettera");
    }
    const coercedDatasetParams: Record<string, unknown> = {};
    for (const parameter of selectedDatasetInfo.parameters) {
      const value = datasetParams[parameter.name];
      if (value !== undefined && value !== "") coercedDatasetParams[parameter.name] = coerce(value, parameter.type);
    }
    const tags = wandbTags.split(",").map((tag) => tag.trim()).filter(Boolean);
    const nntree = JSON.parse(new NNTree(diagram).toJson()) as Record<string, unknown>;
    return buildTrainingRequest({
      nntree,
      datasetTarget: selectedDataset,
      datasetParams: coercedDatasetParams,
      numClasses: selectedDatasetInfo.num_classes,
      batchSize: Number.parseInt(batchSize, 10),
      numWorkers: Number.parseInt(numWorkers, 10),
      trainSize: Number.parseFloat(trainSize),
      optimizerTarget,
      learningRate: Number.parseFloat(learningRate),
      maxEpochs: Number.parseInt(maxEpochs, 10),
      accelerator,
      seed: Number.parseInt(seed, 10),
      wandb: {
        project: wandbProject,
        mode: wandbMode,
        ...(wandbEntity.trim() ? { entity: wandbEntity.trim() } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(wandbRunName.trim() ? { name: wandbRunName.trim() } : {}),
      },
      earlyStopping: {
        patience: Number.parseInt(patience, 10),
        min_delta: Number.parseFloat(minDelta),
      },
      overrides: overridesText.split("\n").map((line) => line.trim()).filter(Boolean),
      resources: {
        cpu: Number.parseInt(cpu, 10),
        memory_gb: Number.parseFloat(memoryGb),
        gpu: Number.parseInt(gpu, 10),
        ...(gpuMemoryGb ? { gpu_memory_gb: Number.parseFloat(gpuMemoryGb) } : {}),
        ...(gpuType ? { gpu_type: gpuType } : {}),
        ...(node ? { node } : {}),
      },
      priority: Number.parseInt(priority, 10),
      packageName: normalizedPackageSuffix ? `nnm_${normalizedPackageSuffix}` : null,
      projectId: projectJob ? activeProject!.id : null,
    });
  }

  async function handleStoreWandbKey() {
    const key = wandbApiKey.trim();
    if (!key) return;
    const stored = await projectState.setWandbKey(key);
    if (stored) {
      wandbApiKey = ""; // write-only: never retain the secret in the UI
      wandbKeyConfigured = true;
    }
  }

  async function handleRemoveWandbKey() {
    const removed = await projectState.deleteWandbKey();
    if (removed) wandbKeyConfigured = false;
  }

  async function handleSaveWandbSettings() {
    await projectState.updateWandb({
      entity: wandbEntity.trim(),
      project: wandbProject.trim() || undefined,
      tags: wandbTags.split(",").map((tag) => tag.trim()).filter(Boolean),
      run_name_template: wandbRunName.trim(),
      mode: wandbMode as "online" | "offline" | "disabled",
    });
  }

  async function submit() {
    if (projectJob && !projectEnvReady) {
      errorMessage = projectEnvMessage || "L'ambiente del progetto non è pronto: sincronizza il progetto prima del training";
      return;
    }
    loading = true;
    errorMessage = "";
    successMessage = "";
    const logWindow = openWaitingWindow("Preparazione del terminale del training…");
    const wandbWindow = wandbMode === "online"
      ? openWaitingWindow("In attesa che W&B inizializzi la run…")
      : null;
    try {
      const job = await requireApi().submitTrainingJob(buildRequest());
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

  function connectionFromGrant(grant: PairingGrant): SavedBackendConnection {
    return {
      version: 1,
      baseUrl: backendUrl,
      token: grant.token,
      connectionId: grant.connection_id,
      requestId: grant.request_id,
      verificationCode: grant.verification_code,
      deviceName: deviceName.trim() || null,
    };
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
    {#if activeProject}
      <section>
        <h3>Progetto</h3>
        {#if projectJob}
          <div class="connection-summary">
            <strong>{activeProject.name}</strong>
            <small>{activeProject.root}</small>
            {#if projectEnv?.status === "ready"}
              <small class="env-ready">Ambiente pronto</small>
            {:else}
              <small class="env-warn">Ambiente: {projectEnv?.status === "missing" ? "da sincronizzare" : "errore"}</small>
              <button onclick={() => void projectState.syncActive()} disabled={projectState.busy}>
                Sincronizza ambiente
              </button>
            {/if}
          </div>
          {#if projectEnvMessage}
            <p class="env-message" role="status">{projectEnvMessage}</p>
          {/if}
          <small>Il job verrà eseguito nel progetto (runs/ e ambiente di progetto).</small>
        {:else}
          <p>
            È attivo il progetto <strong>{activeProject.name}</strong> ma il backend collegato
            non è il companion locale: il job viene inviato senza contesto di progetto.
          </p>
        {/if}
      </section>
    {/if}

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
      {#if datasetCatalogErrors.length > 0}
        <details class="env-message">
          <summary>Diagnostica dataset ({datasetCatalogErrors.length})</summary>
          <ul>
            {#each datasetCatalogErrors as entry (entry.path)}
              <li><strong>{entry.path}</strong>: {entry.error}</li>
            {/each}
          </ul>
        </details>
      {/if}
      <div class="grid">
        <label>Batch size<input type="number" bind:value={batchSize} /></label>
        <label>Worker<input type="number" bind:value={numWorkers} /></label>
        <label>Train split<input type="number" step="0.01" bind:value={trainSize} /></label>
        <label>Seed<input type="number" bind:value={seed} /></label>
      </div>
    </section>

    <section>
      <h3>Hydra</h3>
      <label>Optimizer target<input bind:value={optimizerTarget} /></label>
      <div class="grid">
        <label>Learning rate<input type="number" step="0.0001" bind:value={learningRate} /></label>
        <label>Epochs<input type="number" bind:value={maxEpochs} /></label>
        <label>Accelerator<input bind:value={accelerator} /></label>
        <label>Patience<input type="number" bind:value={patience} /></label>
        <label>Min delta<input type="number" step="0.001" bind:value={minDelta} /></label>
      </div>
      <label>Override Hydra (una per riga)
        <textarea bind:value={overridesText} placeholder="trainer.max_epochs=10"></textarea>
      </label>
    </section>

    <section>
      <h3>W&amp;B</h3>
      <div class="grid">
        <label>Entity<input bind:value={wandbEntity} placeholder="team" /></label>
        <label>Project<input bind:value={wandbProject} /></label>
      </div>
      <label>Tag (separati da virgola)
        <input bind:value={wandbTags} placeholder="prod, experiments" />
      </label>
      <label>Template nome run
        <input bind:value={wandbRunName} placeholder={'run-{epoch}'} />
      </label>
      <label>Mode
        <select bind:value={wandbMode}>
          <option value="online">online</option>
          <option value="offline">offline</option>
          <option value="disabled">disabled</option>
        </select>
      </label>
      <div class="grid">
        <label>API key
          <input type="password" autocomplete="new-password" bind:value={wandbApiKey} placeholder={wandbKeyConfigured ? "Chiave configurata ✓" : "…"} />
        </label>
      </div>
      <div class="actions">
        <button onclick={() => void handleStoreWandbKey()} disabled={projectState.wandbKeyBusy || !wandbApiKey.trim()}>
          {wandbKeyConfigured ? "Aggiorna chiave" : "Salva chiave"}
        </button>
        {#if wandbKeyConfigured}
          <button class="danger" onclick={() => void handleRemoveWandbKey()} disabled={projectState.wandbKeyBusy}>
            Rimuovi chiave
          </button>
        {/if}
      </div>
      {#if projectState.wandbKeyError}
        <p class="env-message" role="alert">{projectState.wandbKeyError}</p>
      {/if}
      <small>La chiave non viene mai salvata nel browser: è conservata solo dal companion.</small>
      {#if projectJob}
        <button onclick={() => void handleSaveWandbSettings()} disabled={projectState.busy}>
          Salva impostazioni W&amp;B nel progetto
        </button>
      {/if}
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
      <button class="submit" onclick={submit} disabled={loading || (projectJob && !projectEnvReady)}>
        {loading ? "Invio..." : "Invia training"}
      </button>
      {#if projectJob && !projectEnvReady}
        <p class="env-message" role="alert">{projectEnvMessage || "Sincronizza l'ambiente del progetto prima del training."}</p>
      {/if}
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
  input, select, textarea { box-sizing: border-box; width: 100%; padding: 6px; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; }
  textarea { min-height: 62px; font-family: monospace; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; } .grid label { margin: 0; }
  button { padding: 6px 9px; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; cursor: pointer; }
  button:hover { background: #e2e8f0; } button:disabled { cursor: wait; opacity: .6; }
  .close { border: 0; background: transparent; font-size: 1.1rem; }
  .primary, .submit { width: 100%; margin-top: 8px; background: #2563eb; color: white; border-color: #2563eb; }
  .danger { color: #991b1b; border-color: #fecaca; background: #fff1f2; }
  .message { padding: 8px; border-radius: 4px; margin-bottom: 8px; font-size: .82rem; } .error { color: #991b1b; background: #fee2e2; } .success { color: #166534; background: #dcfce7; }
  .connection-summary { display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }
  .connection-summary strong { color: #166534; }
  .env-ready { color: #166534; }
  .env-warn { color: #92400e; }
  .env-message { margin: 6px 0 0; padding: 6px 8px; border-radius: 4px; background: #fffbeb; color: #854d0e; font-size: .78rem; }
  .actions { display: flex; gap: 6px; margin-top: 9px; } .actions button { flex: 1; }
  .verification-code { margin: 10px 0; padding: 12px; border: 2px dashed #2563eb; border-radius: 6px; text-align: center; font: 700 1.8rem monospace; letter-spacing: .25rem; }
  code { font-size: .75rem; }
  article { margin: 7px 0; padding: 8px; border: 1px solid #e2e8f0; border-radius: 5px; } article.selected { border-color: #2563eb; }
  .job-title { width: 100%; display: flex; justify-content: space-between; } small { color: #64748b; } pre { max-height: 100px; overflow: auto; white-space: pre-wrap; color: #991b1b; font-size: .72rem; }
</style>
