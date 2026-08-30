/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 */

import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const MAX_PROGRESS_BYTES = 262_144;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

export class RemoteTrainingError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message);
    this.name = "RemoteTrainingError";
  }
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
  job: Record<string, unknown>;
  metrics: Record<string, unknown>;
  diagnostics: string[];
  events: Record<string, unknown>[];
  stdout: { text: string; offset: number; nextOffset: number; reset: boolean };
  stderr: { text: string; offset: number; nextOffset: number; reset: boolean };
  eventCursor: string | null;
  nextEventCursor: string | null;
  timedOut: boolean;
}

export interface WheelArtifact {
  kind: "wheel";
  path: string;
  mediaType: "application/octet-stream";
  bytes: number;
  sha256: string;
}

/**
 * Thin HTTP client for the optional FastAPI remote-training backend.
 *
 * Authentication parity with the browser client: the browser sends
 * `authorization: Bearer <token>` on every authenticated request (the token is
 * injected into `TrainingApiClient` from the pairing flow). This client does
 * the same whenever a token is configured — explicitly, or from the
 * `NNM_BACKEND_TOKEN` environment variable mirroring `NNM_BACKEND_URL`. When
 * no token is configured the header is omitted (unchanged behavior) and the
 * backend answers 401. Acquiring/renewing a token (the pairing flow) remains a
 * deployment concern; this client only transports an operator-provided token.
 */

export class RemoteTrainingClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly artifactRoot: string;

  constructor(
    baseUrl = process.env.NNM_BACKEND_URL ?? "http://127.0.0.1:8000",
    token = process.env.NNM_BACKEND_TOKEN,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token && token.length > 0 ? token : undefined;
    this.artifactRoot = resolve(process.env.NNM_ARTIFACT_ROOT ?? join(tmpdir(), "nnm-mcp-artifacts"));
  }

  /** Merge the caller's headers with the configured bearer token, if any. */
  private headers(headers?: HeadersInit): Headers {
    const merged = new Headers(headers);
    if (this.token) {
      merged.set("authorization", `Bearer ${this.token}`);
    }
    return merged;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init?.headers),
    });
    const text = await response.text();
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const detail = typeof body === "object" && body !== null && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : text || response.statusText;
      throw new Error(`Training backend ${response.status}: ${detail}`);
    }
    return body as T;
  }

  health(): Promise<Record<string, unknown>> {
    return this.request("/health");
  }

  listDatasets(): Promise<unknown[]> {
    return this.request("/datasets");
  }

  listComputeUnits(): Promise<unknown[]> {
    return this.request("/compute-units");
  }

  submitJob(job: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job),
    });
  }

  getJob(jobId: string): Promise<Record<string, unknown>> {
    return this.request(`/jobs/${encodeURIComponent(jobId)}`);
  }

  listJobs(): Promise<unknown[]> {
    return this.request("/jobs");
  }

  getLogs(jobId: string): Promise<Record<string, string>> {
    return this.request(`/jobs/${encodeURIComponent(jobId)}/logs`);
  }

  async readProgress(jobId: string, options: TrainingProgressOptions = {}): Promise<TrainingProgressResult> {
    const stdoutOffset = bounded(options.stdoutOffset ?? 0, 0, "stdoutOffset");
    const stderrOffset = bounded(options.stderrOffset ?? 0, 0, "stderrOffset");
    const waitMs = bounded(options.waitMs ?? 0, 0, "waitMs", 30000);
    const maxBytes = bounded(options.maxBytes ?? MAX_PROGRESS_BYTES, 1, "maxBytes", MAX_PROGRESS_BYTES);
    const [job, logs] = await Promise.all([
      this.getJob(jobId),
      this.request<{ stdout: { text: string; offset: number; reset: boolean }; stderr: { text: string; offset: number; reset: boolean } }>(
        `/jobs/${encodeURIComponent(jobId)}/logs/tail?stdout_after=${stdoutOffset}&stderr_after=${stderrOffset}`,
      ),
    ]);
    const events = await this.readEventsWindow(jobId, options.eventCursor, waitMs, maxBytes, options.signal);
    const metrics: Record<string, unknown> = {};
    const diagnostics: string[] = [];
    for (const event of events.events) {
      if (event.metrics && typeof event.metrics === "object" && !Array.isArray(event.metrics)) Object.assign(metrics, event.metrics);
      if (typeof event.error === "string") diagnostics.push(event.error);
      if (typeof event.diagnostic === "string") diagnostics.push(event.diagnostic);
    }
    return {
      status: "ok", job, metrics, diagnostics, events: events.events,
      stdout: { ...logs.stdout, nextOffset: logs.stdout.offset },
      stderr: { ...logs.stderr, nextOffset: logs.stderr.offset },
      eventCursor: options.eventCursor ?? null, nextEventCursor: events.nextEventCursor,
      timedOut: events.timedOut,
    };
  }

  private async readEventsWindow(jobId: string, cursor: string | undefined, waitMs: number, maxBytes: number, signal?: AbortSignal): Promise<{ events: Record<string, unknown>[]; nextEventCursor: string | null; timedOut: boolean }> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), waitMs);
    const events: Record<string, unknown>[] = [];
    let nextEventCursor = cursor ?? null;
    try {
      const query = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
      const response = await fetch(`${this.baseUrl}/jobs/${encodeURIComponent(jobId)}/events${query}`, { headers: this.headers({ accept: "text/event-stream" }), signal: controller.signal });
      if (!response.ok) throw await this.requestError(response);
      if (!response.body) throw new RemoteTrainingError("EVENTS_STREAM_MISSING", "Training backend did not return an event stream", 502);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let bytes = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > maxBytes) throw new RemoteTrainingError("PROGRESS_TOO_LARGE", "Progress window exceeds the byte limit", 413);
        buffer += decoder.decode(item.value, { stream: true }).replace(/\r\n/g, "\n");
        let split = buffer.indexOf("\n\n");
        while (split >= 0) {
          const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const id = frame.match(/^id:\s*(.+)$/m)?.[1];
          const data = frame.match(/^data:\s*(.+)$/m)?.[1];
          if (id) nextEventCursor = id;
          if (data) events.push(JSON.parse(data) as Record<string, unknown>);
          split = buffer.indexOf("\n\n");
        }
      }
      return { events, nextEventCursor, timedOut: false };
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError") return { events, nextEventCursor, timedOut: true };
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
    }
  }

  async downloadWheel(jobId: string, destinationPath?: string): Promise<{ status: "ok"; artifact: WheelArtifact }> {
    const job = await this.getJob(jobId);
    const manifest = job.model_package as Record<string, unknown> | null | undefined;
    if (!manifest || typeof manifest !== "object") throw new RemoteTrainingError("ARTIFACT_UNAVAILABLE", "Model package is not available");
    const sha256 = typeof manifest.sha256 === "string" && /^[0-9a-f]{64}$/i.test(manifest.sha256) ? manifest.sha256.toLowerCase() : null;
    if (!sha256) throw new RemoteTrainingError("ARTIFACT_MANIFEST_INVALID", "Model package manifest has no valid SHA-256 digest", 502);
    const name = safeName(typeof manifest.wheel === "string" ? basename(manifest.wheel) : "model.whl");
    await mkdir(this.artifactRoot, { recursive: true, mode: 0o700 });
    const path = destinationPath ? this.validateDestination(destinationPath) : join(this.artifactRoot, `nnm-${safeName(jobId)}-${name}`);
    let handle;
    try { handle = await open(path, "wx", 0o600); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RemoteTrainingError("ARTIFACT_EXISTS", "Artifact destination already exists");
      throw new RemoteTrainingError("ARTIFACT_WRITE_FAILED", "Could not create artifact destination");
    }
    try {
      const response = await fetch(`${this.baseUrl}/jobs/${encodeURIComponent(jobId)}/package`, { headers: this.headers() });
      if (!response.ok) throw await this.requestError(response);
      const header = response.headers.get("x-nnm-sha256");
      if (!header || !/^[0-9a-f]{64}$/i.test(header) || header.toLowerCase() !== sha256) throw new RemoteTrainingError("ARTIFACT_DIGEST_MISMATCH", "Package digest does not match the owned manifest", 502);
      if (!response.body) throw new RemoteTrainingError("ARTIFACT_UNAVAILABLE", "Package response has no body", 404);
      const reader = response.body.getReader(); const digest = createHash("sha256"); let bytes = 0;
      while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; if (bytes > MAX_ARTIFACT_BYTES) throw new RemoteTrainingError("ARTIFACT_TOO_LARGE", "Wheel exceeds the transfer limit", 413); digest.update(item.value); await handle.write(item.value); }
      if (digest.digest("hex") !== sha256) throw new RemoteTrainingError("ARTIFACT_CORRUPTED", "Downloaded wheel failed SHA-256 verification", 502);
      return { status: "ok", artifact: { kind: "wheel", path, mediaType: "application/octet-stream", bytes, sha256 } };
    } catch (error) { await rm(path, { force: true }); throw error; } finally { await handle.close(); }
  }

  private validateDestination(destinationPath: string): string {
    const path = resolve(destinationPath); const root = `${this.artifactRoot}/`;
    if (!path.startsWith(root) || safeName(basename(path)) !== basename(path)) throw new RemoteTrainingError("ARTIFACT_PATH_INVALID", "Artifact destination must be a sanitized file in the private artifact directory", 400);
    return path;
  }

  private async requestError(response: Response): Promise<RemoteTrainingError> {
    if (response.status === 401 || response.status === 403) return new RemoteTrainingError("AUTHORIZATION_FAILED", "Training backend authorization failed", response.status);
    return new RemoteTrainingError(response.status === 404 ? "ARTIFACT_UNAVAILABLE" : `HTTP_${response.status}`, `Training backend ${response.status}: ${response.statusText}`, response.status);
  }

  cancelJob(jobId: string): Promise<Record<string, unknown>> {
    return this.request(`/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
  }

  async getEvents(jobId: string, after?: string): Promise<unknown[]> {
    return (await this.readEventsWindow(jobId, after, 30000, MAX_PROGRESS_BYTES)).events;
  }
}

function bounded(value: number, minimum: number, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RemoteTrainingError(`INVALID_${field.toUpperCase()}`, `${field} must be an integer between ${minimum} and ${maximum}`, 400);
  return value;
}

function safeName(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : "model.whl";
}
