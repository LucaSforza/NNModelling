import type { PackageBundleV1 } from "./package-bundle";
import type { DatasetDefinition, DatasetReference, DatasetSourceManifest } from "../project-workspace/dataset-contract";

export interface DatasetParameter {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
}

export interface DatasetInfo {
  reference: DatasetReference;
  manifest: DatasetSourceManifest;
  definition: DatasetDefinition;
}

/** Keep the submitted constructor arguments aligned with the registered schema.
 *
 * This also protects an already-open editor from stale fields left by an older
 * dataset contract (for example the removed browser-controlled ``root``).
 */
export function canonicalDatasetParameters(
  dataset: DatasetInfo,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
  dataset.definition.parameters
      .filter((parameter) => Object.hasOwn(values, parameter.name))
    .map((parameter) => [parameter.name, values[parameter.name]!]),
  );
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
  dataset: { reference: DatasetReference; parameters: Record<string, string | number | boolean> } | null;
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

export interface TrainingProgressOptions {
  eventCursor?: string;
  stdoutOffset?: number;
  stderrOffset?: number;
  waitMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface TrainingProgressResult {
  status: "ok";
  job: TrainingJobStatus;
  metrics: Record<string, unknown>;
  diagnostics: string[];
  events: Record<string, unknown>[];
  stdout: TrainingLogChunk & { nextOffset: number };
  stderr: TrainingLogChunk & { nextOffset: number };
  eventCursor: string | null;
  nextEventCursor: string | null;
  timedOut: boolean;
}

export interface TrainingJobRequest {
  schema_version: number;
  network: { format: "package"; value: { bundle_ref: string; graph: PackageBundleV1["graph"] } };
  training: TrainingRequest;
  resources: ResourceRequest;
  priority: number;
}

export interface OpaqueDatasetRequest { reference: DatasetReference; parameters: Record<string, string | number | boolean>; }
export interface TrainingRequest {
  dataset: OpaqueDatasetRequest;
  seed: number;
  optimizer: { target: string; learning_rate: number };
  trainer: { max_epochs: number; accelerator: "auto" | "cpu" | "cuda"; patience: number; min_delta: number };
  wandb: { project: string; mode: "disabled" | "offline" | "online" };
}
export interface ResourceRequest {
  cpu: number; memory_gb: number; gpu: number;
  gpu_memory_gb?: number; gpu_type?: string; node?: string;
}

export interface PackageBundleUploadResponse {
  bundle_ref: string;
  digest: string;
  size: number;
}

export interface DatasetArchiveUploadResponse {
  reference: DatasetReference;
  digest: string;
  size: number;
  limit: number;
}

export interface DatasetArchiveCapabilities { format: "zip"; max_bytes: number }

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

  datasetArchiveCapabilities(): Promise<DatasetArchiveCapabilities> {
    return this.request("/dataset-archives/capabilities");
  }

  async uploadDatasetArchive(bytes: Uint8Array): Promise<DatasetArchiveUploadResponse> {
    const digest = await sha256Hex(bytes as Uint8Array<ArrayBuffer>);
    return this.request("/dataset-archives", {
      method: "POST",
      headers: { "content-type": "application/zip", "x-nnm-sha256": digest },
      body: bytes as BodyInit,
    });
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

  /**
   * Upload an immutable package bundle before submitting its job reference.
   * Contract v1 currently assumes JSON transport; the backend may later wrap
   * the same canonical payload in a streamed archive without changing callers.
   */
  async uploadPackageBundle(bundle: PackageBundleV1): Promise<PackageBundleUploadResponse> {
    const response = await this.request<PackageBundleUploadResponse>("/package-bundles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    const digest = requireSha256Hex(response.digest, 502, "bundle_digest_invalid", "Il backend ha restituito un digest bundle non valido");
    if (digest !== bundle.digest) {
      throw new BackendApiError(502, "bundle_digest_mismatch", "Il digest del bundle restituito dal backend non corrisponde al bundle inviato");
    }
    return { ...response, digest };
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

  /** Read one bounded progress window; the event and log cursors are independent. */
  async readTrainingProgress(jobId: string, options: TrainingProgressOptions = {}): Promise<TrainingProgressResult> {
    const stdoutOffset = boundedInteger(options.stdoutOffset ?? 0, 0, "stdoutOffset");
    const stderrOffset = boundedInteger(options.stderrOffset ?? 0, 0, "stderrOffset");
    const waitMs = boundedInteger(options.waitMs ?? 0, 0, "waitMs", 30000);
    const maxBytes = boundedInteger(options.maxBytes ?? 262144, 1, "maxBytes", 262144);
    const eventCursor = options.eventCursor;
    if (eventCursor !== undefined && eventCursor.length === 0) throw new BackendApiError(400, "invalid_event_cursor", "Il cursore eventi non può essere vuoto");

    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), waitMs);
    try {
      const [job, logs] = await Promise.all([
        this.getTrainingJob(jobId),
        this.tailTrainingJobLogs(jobId, stdoutOffset, stderrOffset),
      ]);
      const eventResult = await this.readEventWindow(jobId, eventCursor, waitMs, maxBytes, controller.signal);
      return {
        status: "ok",
        job,
        metrics: eventResult.metrics,
        diagnostics: eventResult.diagnostics,
        events: eventResult.events,
        stdout: { ...logs.stdout, nextOffset: logs.stdout.offset },
        stderr: { ...logs.stderr, nextOffset: logs.stderr.offset },
        eventCursor: eventCursor ?? null,
        nextEventCursor: eventResult.nextEventCursor,
        timedOut: eventResult.timedOut,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private async readEventWindow(jobId: string, cursor: string | undefined, waitMs: number, maxBytes: number, signal: AbortSignal): Promise<{
    events: Record<string, unknown>[];
    metrics: Record<string, unknown>;
    diagnostics: string[];
    nextEventCursor: string | null;
    timedOut: boolean;
  }> {
    const query = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
    const headers = this.authHeaders();
    headers.set("accept", "text/event-stream");
    if (cursor) headers.set("last-event-id", cursor);
    const events: Record<string, unknown>[] = [];
    let nextEventCursor = cursor ?? null;
    const metrics: Record<string, unknown> = {};
    const diagnostics: string[] = [];
    try {
      const response = await fetch(`${this.baseUrl}/jobs/${encodeURIComponent(jobId)}/events${query}`, { headers, signal });
      if (!response.ok) throw await responseError(response);
      if (!response.body) throw new BackendApiError(502, "events_stream_missing", "Il backend non ha restituito uno stream eventi");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      let bytes = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > maxBytes) throw new BackendApiError(413, "progress_too_large", "La finestra di progress supera il limite di byte");
          for (const message of parser.push(decoder.decode(item.value, { stream: true }))) {
            if (message.id) nextEventCursor = message.id;
            const event = JSON.parse(message.data) as Record<string, unknown>;
            events.push(event);
            collectProgress(event, metrics, diagnostics);
          }
        }
        for (const message of parser.push(decoder.decode())) {
          if (message.id) nextEventCursor = message.id;
          const event = JSON.parse(message.data) as Record<string, unknown>;
          events.push(event);
          collectProgress(event, metrics, diagnostics);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return { events, metrics, diagnostics, nextEventCursor, timedOut: false };
    } catch (error) {
      if (isTimeoutAbort(error, signal)) return { events, metrics, diagnostics, nextEventCursor, timedOut: true };
      throw error;
    }
  }

  /**
   * Download the authenticated job's wheel, verifying its integrity before any
   * byte is returned.
   *
   * The selected package name is sent to the backend for download-time wheel
   * generation. The server exposes the digest of those selected bytes through
   * the `X-NNM-SHA256` response header; the header must be present and
   * well-formed, and the body must match it before any Blob is returned.
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
  async downloadModelPackage(jobId: string, packageName: string): Promise<Blob> {
    const selectedPackageName = requirePackageName(packageName);
    requireWebCrypto();
    const query = new URLSearchParams({ packageName: selectedPackageName });
    const response = await fetch(`${this.baseUrl}/jobs/${encodeURIComponent(jobId)}/package?${query}`, {
      headers: this.authHeaders(),
    });
    if (!response.ok) throw await responseError(response);

    const header = response.headers.get("x-nnm-sha256");
    if (header === null) {
      throw new BackendApiError(502, "package_digest_missing",
        "Il server non ha restituito il digest SHA-256 del package; il download è stato annullato");
    }
    const declared = requireSha256Hex(header, 502, "package_digest_invalid",
      "Il digest SHA-256 restituito dal server non è valido; il download è stato annullato");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const bodyDigest = await sha256Hex(bytes);
    if (bodyDigest !== declared) {
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
      if (!response.ok) throw await responseError(response);
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
    if (!response.ok) throw await responseError(response);
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

const PACKAGE_NAME = /^nnm_[A-Za-z][A-Za-z0-9_]*$/;

export function requirePackageName(value: string): string {
  if (!PACKAGE_NAME.test(value)) {
    throw new BackendApiError(400, "invalid_package_name", "Il nome package deve avere il formato nnm_<nome>");
  }
  return value;
}

export function wheelFilename(packageName: string, version: string): string {
  return `${requirePackageName(packageName)}-${version}-py3-none-any.whl`;
}

async function responseError(response: Response): Promise<BackendApiError> {
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
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
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

function boundedInteger(value: number, minimum: number, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new BackendApiError(400, `invalid_${field}`, `${field} deve essere un intero tra ${minimum} e ${maximum}`);
  }
  return value;
}

function isTimeoutAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (signal.reason instanceof DOMException && signal.reason.name === "TimeoutError");
}

function collectProgress(event: Record<string, unknown>, metrics: Record<string, unknown>, diagnostics: string[]): void {
  const eventMetrics = event.metrics;
  if (eventMetrics && typeof eventMetrics === "object" && !Array.isArray(eventMetrics)) Object.assign(metrics, eventMetrics);
  if (typeof event.error === "string") diagnostics.push(event.error);
  if (typeof event.diagnostic === "string") diagnostics.push(event.diagnostic);
  const packageError = event.package_error;
  if (typeof packageError === "string") diagnostics.push(packageError);
}
