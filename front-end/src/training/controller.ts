import {
  BackendApiError,
  TrainingApiClient,
  type DatasetInfo,
  type PairingGrant,
  type SessionInfo,
} from "./api";
import {
  forgetBackendConnection,
  loadBackendConnection,
  normalizeBackendUrl,
  saveBackendConnection,
  type ConnectionStorage,
  type SavedBackendConnection,
} from "./connection";
import type { Edge, Node } from "@xyflow/svelte";
import type { Diagram } from "../Diagram.svelte";
import { buildPackageBundle, canonicalJson, type PackageBundleV1 } from "./package-bundle";
import type { PackageExportInfo } from "../type-system/packages/types";
import type { GraphInferenceResult } from "../type-system/graph/types";
import type { TrainingJobRequest, TrainingJobStatus, TrainingProgressOptions, TrainingProgressResult } from "./api";

export type TrainingConnectionState =
  | "disconnected"
  | "checking"
  | "pending"
  | "active"
  | "expired"
  | "rejected"
  | "error";

export interface TrainingConnectionView {
  status: TrainingConnectionState;
  baseUrl: string | null;
  deviceName: string | null;
  requestId: string | null;
  connectionId: string | null;
  verificationCode: string | null;
  expiresAt: string | null;
  sessionExpiresAt: string | null;
  error: string | null;
}

export interface TrainingConfig {
  selectedDataset: string;
  datasetParams: Record<string, unknown>;
  seed: number;
  optimizerTarget: string;
  learningRate: number;
  maxEpochs: number;
  accelerator: "auto" | "cpu" | "cuda";
  patience: number;
  minDelta: number;
  wandbProject: string;
  wandbMode: "disabled" | "offline" | "online";
  cpu: number;
  memoryGb: number;
  gpu: number;
  gpuMemoryGb?: number;
  gpuType?: string;
  node?: string;
  priority: number;
  packageSuffix?: string;
}

export type TrainingConfigPatch = Partial<TrainingConfig>;

export class TrainingConfigurationError extends Error {
  readonly code = "INVALID_CONFIGURATION";

  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "TrainingConfigurationError";
  }
}

export class TrainingSubmissionError extends Error {
  readonly code = "SUBMISSION_UNKNOWN";

  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "TrainingSubmissionError";
  }
}

/** The browser-owned data needed to prepare one immutable training snapshot. */
export interface TrainingDiagramSource {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  readonly typeResult: GraphInferenceResult | null;
  readonly waitForPackageRuntime: () => Promise<void>;
  readonly packageExports: () => ReadonlyMap<string, PackageExportInfo>;
}

export interface PreparedTrainingSubmission {
  readonly request: TrainingJobRequest;
  readonly bundle: PackageBundleV1;
  readonly bundleRef: string;
  readonly snapshotDigest: string;
}

export interface TrainingSubmissionResult {
  readonly status: "ok";
  readonly jobId: string;
  readonly bundleRef: string;
  readonly bundleDigest: string;
  readonly snapshotDigest: string;
  readonly job: TrainingJobStatus;
}

export interface TrainingWheelDownload {
  readonly status: "ok";
  readonly artifact: {
    readonly filename: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly base64: string;
  };
}

export interface TrainingControllerSnapshot {
  connection: TrainingConnectionView;
  config: TrainingConfig;
  datasets: DatasetInfo[];
}

export type TrainingControllerListener = (snapshot: TrainingControllerSnapshot) => void;

export interface TrainingControllerOptions {
  storage?: ConnectionStorage;
  apiFactory?: (baseUrl: string, token?: string | null) => TrainingApiClient;
}

const DEFAULT_CONFIG: TrainingConfig = {
  selectedDataset: "",
  datasetParams: {},
  seed: 42,
  optimizerTarget: "torch.optim.Adam",
  learningRate: 0.001,
  maxEpochs: 20,
  accelerator: "auto",
  patience: 3,
  minDelta: 0,
  wandbProject: "NeuralNetworks",
  wandbMode: "disabled",
  cpu: 4,
  memoryGb: 8,
  gpu: 0,
  priority: 0,
};

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG).concat([
  "gpuMemoryGb", "gpuType", "node", "packageSuffix",
]));

/**
 * Project-scoped owner of the browser training session and its configuration.
 * The sidebar is only a view: closing it must not tear down this controller.
 */
export class TrainingController {
  private readonly storage?: ConnectionStorage;
  private readonly apiFactory: (baseUrl: string, token?: string | null) => TrainingApiClient;
  private api: TrainingApiClient | null = null;
  private savedConnection: SavedBackendConnection | null = null;
  private pairing: PairingGrant | null = null;
  private connection: TrainingConnectionView = disconnectedView();
  private config: TrainingConfig = cloneConfig(DEFAULT_CONFIG);
  private datasets: DatasetInfo[] = [];
  private listeners = new Set<TrainingControllerListener>();
  private generation = 0;
  private pairingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: TrainingControllerOptions = {}) {
    this.storage = options.storage;
    this.apiFactory = options.apiFactory ?? ((baseUrl, token) => new TrainingApiClient(baseUrl, token));
  }

  subscribe(listener: TrainingControllerListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): TrainingControllerSnapshot {
    return {
      connection: { ...this.connection },
      config: cloneConfig(this.config),
      datasets: this.datasets.map((dataset) => ({ ...dataset, parameters: dataset.parameters.map((parameter) => ({ ...parameter })) })),
    };
  }

  getConnection(): TrainingConnectionView {
    return { ...this.connection };
  }

  getConfig(): TrainingConfig {
    return cloneConfig(this.config);
  }

  getDatasets(): DatasetInfo[] {
    return this.snapshot().datasets;
  }

  isSubmissionCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  /** Install the browser-provided descriptor catalog and materialize defaults. */
  setDatasets(datasets: readonly DatasetInfo[]): TrainingConfig {
    this.datasets = datasets.map((dataset) => ({ ...dataset, parameters: dataset.parameters.map((parameter) => ({ ...parameter })) }));
    if (!this.config.selectedDataset && this.datasets[0]) {
      this.config = { ...this.config, selectedDataset: this.datasets[0].target, datasetParams: datasetDefaults(this.datasets[0]) };
    }
    this.emit();
    return this.getConfig();
  }

  /** Browser-only access for the sidebar's existing job and bundle actions. */
  getApi(): TrainingApiClient {
    if (!this.api) throw new BackendApiError(401, "missing_token", "La connessione non ha un token");
    return this.api;
  }

  /** Read one bounded, resumable progress window for the paired owner. */
  readTrainingProgress(jobId: string, options: TrainingProgressOptions = {}): Promise<TrainingProgressResult> {
    if (this.connection.status !== "active") {
      return Promise.reject(new BackendApiError(401, "backend_not_connected", "Il backend di training non è connesso"));
    }
    return this.getApi().readTrainingProgress(jobId, options);
  }

  /** Download a verified wheel for the paired owner without exposing its token. */
  async downloadTrainingWheel(jobId: string): Promise<TrainingWheelDownload> {
    if (this.connection.status !== "active") {
      throw new BackendApiError(401, "backend_not_connected", "Il backend di training non è connesso");
    }
    const job = await this.getApi().getTrainingJob(jobId);
    const manifest = job.model_package;
    if (!manifest || !/^[0-9a-f]{64}$/i.test(manifest.sha256)) {
      throw new BackendApiError(404, "package_unavailable", "Il job non espone un package verificabile");
    }
    const blob = await this.getApi().downloadModelPackage(jobId, manifest.sha256);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      status: "ok",
      artifact: {
        filename: manifest.wheel.split(/[\\/]/).pop() || "model.whl",
        bytes: bytes.byteLength,
        sha256: manifest.sha256.toLowerCase(),
        base64: bytesToBase64(bytes),
      },
    };
  }

  async restore(): Promise<void> {
    const restored = loadBackendConnection(this.storage);
    if (!restored) return;
    this.savedConnection = restored;
    this.api = this.apiFactory(restored.baseUrl, restored.token);
    this.connection = {
      ...this.connection,
      status: "checking",
      baseUrl: restored.baseUrl,
      deviceName: restored.deviceName,
      connectionId: restored.connectionId,
    };
    this.emit();
    try {
      if (restored.requestId) {
        this.pairing = {
          request_id: restored.requestId,
          connection_id: restored.connectionId,
          token: restored.token,
          verification_code: restored.verificationCode ?? "",
          expires_at: "",
        };
        await this.checkPairing();
      } else {
        await this.activate(await this.api.getSession());
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  async connect(baseUrl: string, deviceName = ""): Promise<TrainingConnectionView> {
    this.invalidate();
    this.connection = { ...disconnectedView(), status: "checking" };
    this.emit();
    try {
      const normalized = normalizeBackendUrl(baseUrl);
      const publicApi = this.apiFactory(normalized);
      await publicApi.health();
      const grant = await publicApi.createPairing(deviceName.trim() || null);
      this.api = this.apiFactory(normalized, grant.token);
      this.pairing = grant;
      this.savedConnection = connectionFromGrant(grant, normalized, deviceName);
      saveBackendConnection(this.savedConnection, this.storage);
      this.connection = pendingView(this.savedConnection, grant);
      this.startPairingTimer();
      this.emit();
      return this.getConnection();
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async renew(): Promise<TrainingConnectionView> {
    if (!this.api || !this.savedConnection) throw new BackendApiError(401, "missing_token", "La connessione non ha un token");
    this.invalidate();
    this.connection = { ...this.connection, status: "checking", error: null };
    this.emit();
    try {
      const grant = await this.api.createRenewal();
      this.pairing = grant;
      this.savedConnection = connectionFromGrant(grant, this.savedConnection.baseUrl, this.savedConnection.deviceName ?? "");
      saveBackendConnection(this.savedConnection, this.storage);
      this.connection = pendingView(this.savedConnection, grant);
      this.startPairingTimer();
      this.emit();
      return this.getConnection();
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async disconnect(revoke = false): Promise<TrainingConnectionView> {
    const api = this.api;
    this.invalidate();
    try {
      if (revoke && api) await api.revokeSession();
    } finally {
      if (this.savedConnection) forgetBackendConnection(this.savedConnection.baseUrl, this.storage);
      this.api = null;
      this.savedConnection = null;
      this.pairing = null;
      this.datasets = [];
      this.connection = disconnectedView();
      this.emit();
    }
    return this.getConnection();
  }

  updateConfig(patch: TrainingConfigPatch): TrainingConfig {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new TrainingConfigurationError("La patch della configurazione deve essere un oggetto");
    }
    const unknown = Object.keys(patch).filter((key) => !CONFIG_KEYS.has(key));
    if (unknown.length > 0) {
      throw new TrainingConfigurationError(`Campo di configurazione sconosciuto: ${unknown.join(", ")}`, { fields: unknown });
    }
    const normalizedPatch = { ...patch } as Record<string, unknown>;
    for (const key of ["gpuMemoryGb", "gpuType", "node", "packageSuffix"]) {
      if (normalizedPatch[key] === null) normalizedPatch[key] = undefined;
    }
    const next = { ...this.config, ...normalizedPatch, datasetParams: patch.datasetParams === undefined
      ? { ...this.config.datasetParams }
      : { ...this.config.datasetParams, ...(patch.datasetParams as Record<string, unknown>) } } as TrainingConfig;
    validateConfig(next, this.datasets);
    if (JSON.stringify(next) === JSON.stringify(this.config)) return this.getConfig();
    this.config = next;
    // Configuration is part of the pending submission snapshot. Any change
    // invalidates preparation that is waiting on runtime or upload I/O.
    this.generation += 1;
    this.emit();
    return this.getConfig();
  }

  /** Build, upload and submit using the same path as the training sidebar. */
  async submitTraining(diagram: Diagram | TrainingDiagramSource): Promise<TrainingSubmissionResult> {
    const prepared = await this.prepareTrainingSubmission(diagram);
    let job: TrainingJobStatus;
    try {
      job = await this.getApi().submitTrainingJob(prepared.request);
    } catch (error) {
      // A network/5xx response may have been accepted by the backend. Never
      // retry it implicitly, since that could queue a duplicate job.
      if (error instanceof BackendApiError && error.status < 500) throw error;
      throw new TrainingSubmissionError(
        "La richiesta di training potrebbe essere stata accettata; non verrà ritentata automaticamente",
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (this.generation !== prepared.generation || !sameDiagramSnapshot(diagram, prepared.diagramFingerprint, prepared.exportScope)) {
      throw new TrainingSubmissionError("Il progetto o la configurazione sono cambiati durante l'invio; nessun risultato è affidabile");
    }
    return {
      status: "ok",
      jobId: job.id,
      bundleRef: prepared.uploaded.bundle_ref,
      bundleDigest: prepared.bundle.digest,
      snapshotDigest: prepared.snapshotDigest,
      job,
    };
  }

  private async prepareTrainingSubmission(diagram: Diagram | TrainingDiagramSource): Promise<PreparedTrainingSubmission & {
    readonly generation: number;
    readonly diagramFingerprint: string;
    readonly exportScope: ReadonlyMap<string, PackageExportInfo>;
    readonly uploaded: { bundle_ref: string; digest: string; size: number };
  }> {
    if (this.connection.status !== "active") {
      throw new BackendApiError(401, "backend_not_connected", "Il backend di training non è connesso");
    }
    const generation = this.generation;
    const config = this.getConfig();
    const dataset = this.datasets.find((candidate) => candidate.target === config.selectedDataset);
    if (!dataset) throw new TrainingConfigurationError("Seleziona un dataset disponibile prima di accodare il training", { field: "selectedDataset" });
    validateConfig(config, this.datasets);

    await diagram.waitForPackageRuntime();
    assertCurrent(this, generation);
    const nodes = diagram.nodes.map((node) => snapshotNode(node));
    const edges = diagram.edges.map((edge) => ({ ...edge }));
    const exportScope = new Map(diagram.packageExports());
    const diagramFingerprint = fingerprint(nodes, edges);
    const bundle = await buildPackageBundle(nodes, edges, exportScope, diagram.typeResult);
    assertCurrent(this, generation);
    if (!sameDiagramSnapshot(diagram, diagramFingerprint, exportScope)) {
      throw new TrainingSubmissionError("Il progetto è cambiato durante la preparazione; invio annullato");
    }
    const uploaded = await this.getApi().uploadPackageBundle(bundle);
    assertCurrent(this, generation);
    if (!sameDiagramSnapshot(diagram, diagramFingerprint, exportScope)) {
      throw new TrainingSubmissionError("Il progetto è cambiato durante il caricamento; nessun job è stato creato");
    }
    const request: TrainingJobRequest = {
      schema_version: 1,
      network: { format: "package", value: { bundle_ref: uploaded.bundle_ref, graph: bundle.graph } },
      training: {
        dataset: { target: config.selectedDataset, parameters: datasetParameters(dataset, config.datasetParams) },
        seed: config.seed,
        optimizer: { target: config.optimizerTarget, learning_rate: config.learningRate },
        trainer: { max_epochs: config.maxEpochs, accelerator: config.accelerator, patience: config.patience, min_delta: config.minDelta },
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
    return { request, bundle, bundleRef: uploaded.bundle_ref, snapshotDigest: bundle.digest, generation, diagramFingerprint, exportScope, uploaded };
  }

  async refreshDatasets(): Promise<DatasetInfo[]> {
    const generation = this.generation;
    const datasets = await this.getApi().listDatasets();
    if (generation !== this.generation) return this.getDatasets();
    const selected = this.config.selectedDataset;
    this.setDatasets(datasets);
    if (selected) {
      const current = datasets.find((dataset) => dataset.target === selected);
      if (current) {
        this.config = { ...this.config, datasetParams: mergeDatasetDefaults(current, this.config.datasetParams) };
        this.emit();
      }
    }
    return this.getDatasets();
  }

  private async checkPairing(): Promise<void> {
    if (!this.api || !this.pairing || !this.savedConnection) return;
    const generation = this.generation;
    const status = await this.api.getPairingStatus(this.pairing.request_id);
    if (generation !== this.generation) return;
    if (status.status === "approved") {
      this.stopPairingTimer();
      this.pairing = null;
      this.savedConnection = { ...this.savedConnection, requestId: null, verificationCode: null };
      saveBackendConnection(this.savedConnection, this.storage);
      await this.activate(await this.api.getSession());
    } else if (status.status === "rejected" || status.status === "expired") {
      this.stopPairingTimer();
      this.connection = { ...this.connection, status: status.status, expiresAt: status.expires_at, sessionExpiresAt: status.session_expires_at, error: null };
      this.emit();
    } else {
      this.connection = { ...this.connection, status: "pending", expiresAt: status.expires_at, error: null };
      this.emit();
    }
  }

  private async activate(session: SessionInfo): Promise<void> {
    if (!this.api) return;
    this.connection = {
      ...this.connection,
      status: "active",
      requestId: null,
      verificationCode: null,
      connectionId: session.id,
      expiresAt: session.expires_at,
      sessionExpiresAt: session.expires_at,
      error: null,
    };
    this.emit();
    await this.refreshDatasets();
  }

  private startPairingTimer(): void {
    this.stopPairingTimer();
    this.pairingTimer = setInterval(() => void this.checkPairing().catch((error) => this.handleError(error)), 1500);
  }

  private stopPairingTimer(): void {
    if (this.pairingTimer) clearInterval(this.pairingTimer);
    this.pairingTimer = undefined;
  }

  private invalidate(): void {
    this.generation += 1;
    this.stopPairingTimer();
  }

  private handleError(error: unknown): void {
    const status = error instanceof BackendApiError && error.code === "session_expired"
      ? "expired"
      : error instanceof BackendApiError && error.code === "session_revoked" ? "rejected" : "error";
    this.connection = { ...this.connection, status, error: error instanceof Error ? error.message : String(error) };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function disconnectedView(): TrainingConnectionView {
  return { status: "disconnected", baseUrl: null, deviceName: null, requestId: null, connectionId: null, verificationCode: null, expiresAt: null, sessionExpiresAt: null, error: null };
}

function pendingView(connection: SavedBackendConnection, grant: PairingGrant): TrainingConnectionView {
  return {
    status: "pending",
    baseUrl: connection.baseUrl,
    deviceName: connection.deviceName,
    requestId: grant.request_id,
    connectionId: grant.connection_id,
    verificationCode: grant.verification_code,
    expiresAt: grant.expires_at,
    sessionExpiresAt: null,
    error: null,
  };
}

function connectionFromGrant(grant: PairingGrant, baseUrl: string, deviceName: string): SavedBackendConnection {
  return { version: 1, baseUrl, token: grant.token, connectionId: grant.connection_id, requestId: grant.request_id, verificationCode: grant.verification_code, deviceName: deviceName.trim() || null };
}

function cloneConfig(config: TrainingConfig): TrainingConfig {
  return { ...config, datasetParams: { ...config.datasetParams } };
}

function datasetDefaults(dataset: DatasetInfo): Record<string, unknown> {
  return Object.fromEntries(dataset.parameters.map((parameter) => [parameter.name, parameter.default]));
}

function mergeDatasetDefaults(dataset: DatasetInfo, values: Record<string, unknown>): Record<string, unknown> {
  return { ...datasetDefaults(dataset), ...values };
}

function validateConfig(config: TrainingConfig, datasets: readonly DatasetInfo[]): void {
  if (config.selectedDataset) {
    const dataset = datasets.find((candidate) => candidate.target === config.selectedDataset);
    if (datasets.length > 0 && !dataset) throw new TrainingConfigurationError(`Dataset sconosciuto: ${config.selectedDataset}`, { field: "selectedDataset" });
    if (dataset) {
      const allowed = new Map(dataset.parameters.map((parameter) => [parameter.name, parameter]));
      const unknown = Object.keys(config.datasetParams).filter((key) => !allowed.has(key));
      if (unknown.length > 0) throw new TrainingConfigurationError(`Parametro dataset sconosciuto: ${unknown.join(", ")}`, { field: "datasetParams", keys: unknown });
      for (const [key, value] of Object.entries(config.datasetParams)) validateDatasetValue(allowed.get(key)!, value);
    }
  }
  integer(config.seed, "seed");
  if (!config.optimizerTarget.trim()) throw invalid("optimizerTarget", "deve essere valorizzato");
  positive(config.learningRate, "learningRate");
  integerAtLeast(config.maxEpochs, "maxEpochs", 1);
  if (!["auto", "cpu", "cuda"].includes(config.accelerator)) throw invalid("accelerator", "valore non supportato");
  integerAtLeast(config.patience, "patience", 0);
  nonNegative(config.minDelta, "minDelta");
  if (!["disabled", "offline", "online"].includes(config.wandbMode)) throw invalid("wandbMode", "valore non supportato");
  integerAtLeast(config.cpu, "cpu", 0);
  positive(config.memoryGb, "memoryGb");
  integerAtLeast(config.gpu, "gpu", 0);
  if (config.gpuMemoryGb !== undefined) positive(config.gpuMemoryGb, "gpuMemoryGb");
  integer(config.priority, "priority");
  if (config.packageSuffix && !/^[A-Za-z][A-Za-z0-9_]*$/.test(config.packageSuffix)) throw invalid("packageSuffix", "formato non valido");
}

function validateDatasetValue(parameter: DatasetInfo["parameters"][number], value: unknown): void {
  if (value === undefined || value === null) {
    if (parameter.required) throw invalid(`datasetParams.${parameter.name}`, "è obbligatorio");
    return;
  }
  const type = parameter.type.toLowerCase();
  if ((type === "int" || type === "integer") && (!Number.isInteger(value))) throw invalid(`datasetParams.${parameter.name}`, "deve essere un intero");
  if ((type === "float" || type === "number") && (typeof value !== "number" || !Number.isFinite(value))) throw invalid(`datasetParams.${parameter.name}`, "deve essere un numero");
  if ((type === "bool" || type === "boolean") && typeof value !== "boolean") throw invalid(`datasetParams.${parameter.name}`, "deve essere booleano");
  if ((type === "string" || type === "str") && typeof value !== "string") throw invalid(`datasetParams.${parameter.name}`, "deve essere testo");
}

function integer(value: number, field: string): void {
  if (!Number.isInteger(value)) throw invalid(field, "deve essere un intero");
}
function integerAtLeast(value: number, field: string, minimum: number): void {
  integer(value, field);
  if (value < minimum) throw invalid(field, `deve essere almeno ${minimum}`);
}
function positive(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw invalid(field, "deve essere positivo");
}
function nonNegative(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw invalid(field, "non può essere negativo");
}
function invalid(field: string, message: string): TrainingConfigurationError {
  return new TrainingConfigurationError(`${field}: ${message}`, { field });
}

function snapshotNode(node: Node): Node {
  const data = node.data as { package?: unknown; params?: unknown; wheelAdapters?: unknown } | undefined;
  return {
    id: node.id, type: node.type, parentId: node.parentId ?? null,
    data: { package: data?.package, params: data?.params ?? {}, wheelAdapters: Array.isArray(data?.wheelAdapters) ? [...data.wheelAdapters] : [] },
  } as unknown as Node;
}

function fingerprint(nodes: readonly Node[], edges: readonly Edge[]): string {
  return canonicalJson({ nodes, edges });
}

function sameDiagramSnapshot(diagram: TrainingDiagramSource, expectedFingerprint: string, expectedExports: ReadonlyMap<string, PackageExportInfo>): boolean {
  if (fingerprint(diagram.nodes.map(snapshotNode), diagram.edges.map((edge) => ({ ...edge }))) !== expectedFingerprint) return false;
  const current = diagram.packageExports();
  if (current.size !== expectedExports.size) return false;
  for (const [key, expected] of expectedExports) {
    const actual = current.get(key);
    if (!actual || canonicalJson(exportIdentity(actual)) !== canonicalJson(exportIdentity(expected))) return false;
  }
  return true;
}

function exportIdentity(value: PackageExportInfo): Record<string, unknown> {
  return { id: value.manifest.id, version: value.manifest.version, state: value.state, active: value.active, dependencies: value.manifest.dependencies, resolvedDependencies: value.resolvedDependencies };
}

function datasetParameters(dataset: DatasetInfo, values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(dataset.parameters.filter((parameter) => Object.hasOwn(values, parameter.name)).map((parameter) => [parameter.name, values[parameter.name]]));
}

function assertCurrent(controller: TrainingController, generation: number): void {
  if (!controller.isSubmissionCurrent(generation)) throw new TrainingSubmissionError("Il backend o la configurazione sono cambiati durante la preparazione; invio annullato");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
