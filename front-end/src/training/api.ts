export interface DatasetParameter {
  name: string;
  type: string;
  default: unknown;
  required: boolean;
}

export interface DatasetInfo {
  target: string;
  name: string;
  doc: string;
  parameters: DatasetParameter[];
  num_classes: number | null;
  source?: "builtin" | "project";
}

export interface TrainingJobStatus {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  priority: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  executor: string | null;
  compute_unit: string | null;
  error: string | null;
  heartbeat_at: string | null;
  wandb_url: string | null;
  model_package: ModelPackageInfo | null;
  package_error: string | null;
  artifact_dir: string;
}

export interface ModelPackageInfo {
  schema_version: number;
  package_name: string;
  version: string;
  wheel: string;
  sha256: string;
  input_adapter: Record<string, unknown>;
}

export interface TrainingJobLogs {
  stdout: string;
  stderr: string;
}

export interface TrainingLogTail {
  stdout: TrainingLogChunk;
  stderr: TrainingLogChunk;
}

export interface TrainingLogChunk {
  text: string;
  offset: number;
  reset: boolean;
}

export interface TrainingJobRequest {
  schema_version: number;
  network: { format: "nntree"; value: Record<string, unknown> };
  training: Record<string, unknown>;
  resources: Record<string, unknown>;
  priority: number;
  package_name?: string;
  project_id?: string;
}

/**
 * Non-secret W&B job overrides. Project settings are merged as defaults by
 * the job manager; these explicit values win. ``name`` maps the project's
 * ``run_name_template`` to the WandbLogger run-name keyword.
 */
export interface WandbJobSettings {
  project: string;
  mode: string;
  entity?: string;
  tags?: string[];
  name?: string;
}

/** Fully-coerced inputs for building a training request (extracted for tests). */
export interface TrainingRequestBuildInput {
  nntree: Record<string, unknown>;
  datasetTarget: string;
  datasetParams: Record<string, unknown>;
  numClasses: number | null;
  batchSize: number;
  numWorkers: number;
  trainSize: number;
  optimizerTarget: string;
  learningRate: number;
  maxEpochs: number;
  accelerator: string;
  seed: number;
  wandb: WandbJobSettings;
  earlyStopping: { patience: number; min_delta: number };
  overrides: string[];
  resources: Record<string, unknown>;
  priority: number;
  packageName: string | null;
  projectId: string | null;
}

/** Build the W&B job section, emitting optional fields only when configured. */
export function wandbPayload(settings: WandbJobSettings): Record<string, unknown> {
  const payload: Record<string, unknown> = { project: settings.project, mode: settings.mode };
  if (settings.entity) payload.entity = settings.entity;
  if (settings.tags && settings.tags.length > 0) payload.tags = [...settings.tags];
  if (settings.name) payload.name = settings.name;
  return payload;
}

/**
 * Build a complete training job request from coerced UI values. ``projectId``
 * is sent only when the job targets the active local project context.
 */
export function buildTrainingRequest(input: TrainingRequestBuildInput): TrainingJobRequest {
  return {
    schema_version: 1,
    network: { format: "nntree", value: input.nntree },
    training: {
      seed: input.seed,
      ...(input.numClasses === null ? {} : { num_classes: input.numClasses }),
      dataset: {
        _target_: input.datasetTarget,
        ...input.datasetParams,
        batch_size: input.batchSize,
        num_workers: input.numWorkers,
        train_size: input.trainSize,
      },
      optimizer: { _target_: input.optimizerTarget, lr: input.learningRate },
      trainer: { max_epochs: input.maxEpochs, accelerator: input.accelerator },
      wandb: wandbPayload(input.wandb),
      early_stopping: { patience: input.earlyStopping.patience, min_delta: input.earlyStopping.min_delta },
      overrides: input.overrides,
    },
    resources: input.resources,
    priority: input.priority,
    ...(input.packageName ? { package_name: input.packageName } : {}),
    ...(input.projectId ? { project_id: input.projectId } : {}),
  };
}

export interface PairingGrant {
  request_id: string;
  connection_id: string;
  token: string;
  verification_code: string;
  expires_at: string;
}

export interface PairingStatus {
  request_id: string;
  connection_id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  verification_code: string;
  expires_at: string;
  session_expires_at: string | null;
}

export interface SessionInfo {
  id: string;
  device_name: string | null;
  status: string;
  created_at: string;
  approved_at: string | null;
  expires_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
}

interface ApiErrorBody {
  detail?: string | { code?: string; message?: string };
}

export class BackendApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackendApiError";
  }
}

export class TrainingApiClient {
  readonly baseUrl: string;

  constructor(baseUrl: string, private readonly token: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  health(): Promise<{ status: string }> {
    return this.request("/health", {}, false);
  }

  createPairing(deviceName: string | null): Promise<PairingGrant> {
    return this.request("/pairing/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_name: deviceName || null }),
    }, false);
  }

  getPairingStatus(requestId: string): Promise<PairingStatus> {
    return this.request(`/pairing/requests/${encodeURIComponent(requestId)}`);
  }

  createRenewal(): Promise<PairingGrant> {
    return this.request("/pairing/renewals", { method: "POST" });
  }

  getSession(): Promise<SessionInfo> {
    return this.request("/session");
  }

  revokeSession(): Promise<SessionInfo> {
    return this.request("/session", { method: "DELETE" });
  }

  listDatasets(): Promise<DatasetInfo[]> {
    return this.request("/datasets");
  }

  listTrainingJobs(): Promise<TrainingJobStatus[]> {
    return this.request("/jobs");
  }

  submitTrainingJob(job: TrainingJobRequest): Promise<TrainingJobStatus> {
    return this.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job),
    });
  }

  cancelTrainingJob(jobId: string): Promise<TrainingJobStatus> {
    return this.request(`/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
  }

  getTrainingJobLogs(jobId: string): Promise<TrainingJobLogs> {
    return this.request(`/jobs/${encodeURIComponent(jobId)}/logs`);
  }

  getTrainingJob(jobId: string): Promise<TrainingJobStatus> {
    return this.request(`/jobs/${encodeURIComponent(jobId)}`);
  }

  tailTrainingJobLogs(jobId: string, stdoutAfter: number, stderrAfter: number): Promise<TrainingLogTail> {
    const query = new URLSearchParams({
      stdout_after: String(stdoutAfter),
      stderr_after: String(stderrAfter),
    });
    return this.request(`/jobs/${encodeURIComponent(jobId)}/logs/tail?${query}`);
  }

  /**
   * Download the authenticated job's wheel, verifying its integrity before any
   * byte is returned.
   *
   * The authoritative digest comes from the job manifest (`expectedSha256`).
   * The server recomputes and exposes the digest of the bytes it serves
   * through the `X-NNM-SHA256` response header; the header must be present,
   * well-formed and equal to the expected digest. The body is then digested
   * client-side with Web Crypto and must match the expected digest too, so a
   * corrupted or substituted response is never trusted on the header alone.
   *
   * Web Crypto is exposed only in a secure frontend context (HTTPS or
   * localhost). If it is unavailable — or a digest operation rejects — the
   * download is refused with `package_verification_unavailable` and no file is
   * offered; the error points at the frontend context, not at CORS or backend
   * reachability.
   *
   * @throws {BackendApiError} On a missing token, a non-OK response, any
   *   missing/malformed/mismatched header or body digest, or an unavailable
   *   Web Crypto platform. No Blob is produced unless every check passes.
   */
  async downloadModelPackage(jobId: string, expectedSha256: string): Promise<Blob> {
    const expected = requireSha256Hex(expectedSha256, 400, "invalid_expected_digest",
      "Il digest SHA-256 atteso dal manifest del job non è valido");
    requireWebCrypto();
    const response = await fetch(`${this.baseUrl}/jobs/${encodeURIComponent(jobId)}/package`, {
      headers: this.authHeaders(),
    });
    if (!response.ok) throw await apiErrorFromResponse(response);

    const header = response.headers.get("x-nnm-sha256");
    if (header === null) {
      throw new BackendApiError(502, "package_digest_missing",
        "Il server non ha restituito il digest SHA-256 del package; il download è stato annullato");
    }
    const declared = requireSha256Hex(header, 502, "package_digest_invalid",
      "Il digest SHA-256 restituito dal server non è valido; il download è stato annullato");
    if (declared !== expected) {
      throw new BackendApiError(502, "package_digest_mismatch",
        "Il digest SHA-256 restituito dal server non corrisponde al manifest del job; il download è stato annullato");
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const bodyDigest = await sha256Hex(bytes);
    if (bodyDigest !== expected) {
      throw new BackendApiError(502, "package_corrupted",
        "Il package scaricato non ha superato la verifica di integrità SHA-256; il download è stato annullato. Riprova o rigenera il job");
    }
    return new Blob([bytes], { type: "application/octet-stream" });
  }

  async subscribeTrainingEvents(
    jobId: string,
    onEvent: (event: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let cursor: string | null = null;
    let terminal = false;
    while (!signal.aborted && !terminal) {
      const headers = this.authHeaders();
      if (cursor) headers.set("last-event-id", cursor);
      const response = await fetch(`${this.baseUrl}/jobs/${encodeURIComponent(jobId)}/events`, {
        headers,
        signal,
      });
    if (!response.ok) throw await apiErrorFromResponse(response);
      if (!response.body) throw new Error("Il backend non ha restituito uno stream eventi");
      const parser = new SseParser();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const message of parser.push(value)) {
          cursor = message.id ?? cursor;
          const event = JSON.parse(message.data) as Record<string, unknown>;
          onEvent(event);
          terminal = ["succeeded", "failed", "cancelled"].includes(String(event.type));
        }
      }
      if (!terminal && !signal.aborted) await abortableDelay(750, signal);
    }
  }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (authenticated) {
      for (const [name, value] of this.authHeaders()) headers.set(name, value);
    }
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) throw await apiErrorFromResponse(response);
    return await response.json() as T;
  }

  private authHeaders(): Headers {
    if (!this.token) throw new BackendApiError(401, "missing_token", "La connessione non ha un token");
    return new Headers({ authorization: `Bearer ${this.token}` });
  }
}

export interface SseMessage {
  id: string | null;
  data: string;
}

export class SseParser {
  private buffer = "";
  private id: string | null = null;
  private data: string[] = [];

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const messages: SseMessage[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line === "") {
        if (this.data.length > 0) messages.push({ id: this.id, data: this.data.join("\n") });
        this.id = null;
        this.data = [];
      } else if (!line.startsWith(":")) {
        const separator = line.indexOf(":");
        const field = separator >= 0 ? line.slice(0, separator) : line;
        const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
        if (field === "id") this.id = value;
        if (field === "data") this.data.push(value);
      }
      newline = this.buffer.indexOf("\n");
    }
    return messages;
  }
}

export function canCancelTrainingJob(status: TrainingJobStatus["status"]): boolean {
  return status === "queued" || status === "running";
}

/**
 * Map a non-OK HTTP response to a typed {@link BackendApiError}. Shared by the
 * training and project clients so both surfaces expose the same machine
 * readable ``code`` from the backend ``{detail: {code, message}}`` payloads.
 */
export async function apiErrorFromResponse(response: Response): Promise<BackendApiError> {
  const body = await response.json().catch(() => undefined) as ApiErrorBody | undefined;
  const detail = body?.detail;
  const code = typeof detail === "object" && detail?.code ? detail.code : `http_${response.status}`;
  const message = typeof detail === "string"
    ? detail
    : typeof detail === "object" && detail?.message
      ? detail.message
      : response.statusText;
  return new BackendApiError(response.status, code, `${response.status}: ${message}`);
}

const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

/** Return the lowercase hex form of a well-formed SHA-256 digest or throw. */
function requireSha256Hex(value: string, status: number, code: string, message: string): string {
  if (!SHA256_HEX.test(value)) throw new BackendApiError(status, code, message);
  return value.toLowerCase();
}

/**
 * Dedicated error for a frontend context that cannot compute SHA-256 digests.
 *
 * Verified package download depends on Web Crypto, which browsers expose only
 * in a secure context (HTTPS or localhost). Reporting this as CORS or backend
 * reachability would mislead the user; the backend may stay on HTTP as long as
 * the page serving the frontend is itself secure and CORS permits the Origin.
 */
function packageVerificationUnavailable(): BackendApiError {
  return new BackendApiError(
    400,
    "package_verification_unavailable",
    "Il download verificato del package richiede un contesto sicuro del browser (HTTPS o localhost): "
    + "Web Crypto non è disponibile in questa pagina; nessun file è stato salvato. "
    + "Non è un errore del backend: apri il frontend su HTTPS o localhost e riprova",
  );
}

/** Throw when the current context cannot compute SHA-256 digests with Web Crypto. */
function requireWebCrypto(): void {
  if (typeof globalThis.crypto?.subtle?.digest !== "function") throw packageVerificationUnavailable();
}

/**
 * Compute the lowercase hex SHA-256 digest of bytes with Web Crypto. A
 * rejecting digest operation is mapped to the same actionable platform error
 * as the upfront availability check, so verification never fails silently.
 */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  let digest: ArrayBuffer;
  try {
    digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  } catch {
    throw packageVerificationUnavailable();
  }
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}
