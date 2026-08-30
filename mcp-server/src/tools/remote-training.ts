/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 */

/** Optional MCP proxy tools for the FastAPI remote-training backend. */

import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ServerContext } from "../server.js";
import { RemoteTrainingClient } from "../remote-training.js";

const MAX_EDITOR_ARTIFACT_BYTES = 256 * 1024 * 1024;

function client(ctx: ServerContext): RemoteTrainingClient {
  return ctx.remoteTraining ?? new RemoteTrainingClient();
}

export const list_training_datasets = {
  schema: z.object({}),

  async handler(ctx: ServerContext) {
    return client(ctx).listDatasets();
  },
};

export const list_training_compute_units = {
  schema: z.object({}),

  async handler(ctx: ServerContext) {
    return client(ctx).listComputeUnits();
  },
};

export const submit_training_job = {
  schema: z.object({
    job: z.record(z.unknown()).describe("Complete NNModelling training job JSON"),
  }),

  async handler(ctx: ServerContext, input: { job: Record<string, unknown> }) {
    return client(ctx).submitJob(input.job);
  },
};

export const list_training_jobs = {
  schema: z.object({}),

  async handler(ctx: ServerContext) {
    return client(ctx).listJobs();
  },
};

export const get_training_job = {
  schema: z.object({ jobId: z.string().min(1) }),

  async handler(ctx: ServerContext, input: { jobId: string }) {
    return client(ctx).getJob(input.jobId);
  },
};

export const get_training_job_logs = {
  schema: z.object({ jobId: z.string().min(1) }),

  async handler(ctx: ServerContext, input: { jobId: string }) {
    return client(ctx).getLogs(input.jobId);
  },
};

export const get_training_job_events = {
  schema: z.object({ jobId: z.string().min(1), after: z.string().min(1).optional() }),

  async handler(ctx: ServerContext, input: { jobId: string; after?: string }) {
    return client(ctx).getEvents(input.jobId, input.after);
  },
};

/** Return a bounded progress window; event and stdout/stderr cursors are independent. */
export const read_training_progress = {
  schema: z.object({
    jobId: z.string().min(1),
    eventCursor: z.string().min(1).optional(),
    stdoutOffset: z.number().int().min(0).optional(),
    stderrOffset: z.number().int().min(0).optional(),
    waitMs: z.number().int().min(0).max(30000).optional(),
    maxBytes: z.number().int().min(1).max(262144).optional(),
  }),
  async handler(ctx: ServerContext, input: { jobId: string; eventCursor?: string; stdoutOffset?: number; stderrOffset?: number; waitMs?: number; maxBytes?: number }) {
    return client(ctx).readProgress(input.jobId, input);
  },
};

export const download_training_wheel = {
  schema: z.object({ jobId: z.string().min(1), destinationPath: z.string().min(1).optional() }),
  async handler(ctx: ServerContext, input: { jobId: string; destinationPath?: string }) {
    return client(ctx).downloadWheel(input.jobId, input.destinationPath);
  },
};

export const cancel_training_job = {
  schema: z.object({ jobId: z.string().min(1) }),

  async handler(ctx: ServerContext, input: { jobId: string }) {
    return client(ctx).cancelJob(input.jobId);
  },
};

// Editor-scoped training session operations. These deliberately use browser
// RPC: pairing and configuration belong to the selected editor, while the
// legacy process-authenticated tools above remain available for compatibility.
export const connect_training_backend = {
  schema: z.object({ baseUrl: z.string().min(1), deviceName: z.string().max(80).optional() }),
  async handler(ctx: ServerContext, input: { baseUrl: string; deviceName?: string }) {
    return ctx.browser.call("connect_training_backend", input);
  },
};

export const get_training_connection = {
  schema: z.object({}),
  async handler(ctx: ServerContext) {
    return ctx.browser.call("get_training_connection", {});
  },
};

export const renew_training_connection = {
  schema: z.object({}),
  async handler(ctx: ServerContext) {
    return ctx.browser.call("renew_training_connection", {});
  },
};

export const disconnect_training_backend = {
  schema: z.object({ revoke: z.boolean().optional().default(false) }),
  async handler(ctx: ServerContext, input: { revoke?: boolean }) {
    return ctx.browser.call("disconnect_training_backend", input);
  },
};

export const get_training_config = {
  schema: z.object({}),
  async handler(ctx: ServerContext) {
    return ctx.browser.call("get_training_config", {});
  },
};

export const update_training_config = {
  schema: z.object({ patch: z.record(z.unknown()) }),
  async handler(ctx: ServerContext, input: { patch: Record<string, unknown> }) {
    return ctx.browser.call("update_training_config", input);
  },
};

/** Submit the selected editor snapshot through its paired browser session. */
export const start_training = {
  schema: z.object({}),
  async handler(ctx: ServerContext) {
    return ctx.browser.call("start_training", {});
  },
};

/** Monitor the job through the selected editor's paired browser identity. */
export const read_editor_training_progress = {
  schema: z.object({
    jobId: z.string().min(1),
    eventCursor: z.string().min(1).optional(),
    stdoutOffset: z.number().int().min(0).optional(),
    stderrOffset: z.number().int().min(0).optional(),
    waitMs: z.number().int().min(0).max(30000).optional(),
    maxBytes: z.number().int().min(1).max(262144).optional(),
  }),
  async handler(ctx: ServerContext, input: { jobId: string; eventCursor?: string; stdoutOffset?: number; stderrOffset?: number; waitMs?: number; maxBytes?: number }) {
    return ctx.browser.call("read_training_progress", input);
  },
};

/** Download a selected-editor wheel after browser-side digest verification. */
export const download_editor_training_wheel = {
  schema: z.object({ jobId: z.string().min(1), destinationPath: z.string().min(1).optional() }),
  async handler(ctx: ServerContext, input: { jobId: string; destinationPath?: string }) {
    const response = await ctx.browser.call("download_training_wheel", { jobId: input.jobId }) as EditorWheelResponse;
    const artifact = response?.artifact;
    if (response?.status !== "ok" || !artifact || typeof artifact.base64 !== "string") {
      throw new Error("Il browser non ha restituito un package verificato");
    }
    if (!/^[0-9a-f]{64}$/i.test(artifact.sha256) || !Number.isInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > MAX_EDITOR_ARTIFACT_BYTES) {
      throw new Error("Il browser ha restituito un manifest wheel non valido");
    }
    const bytes = Buffer.from(artifact.base64, "base64");
    if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256.toLowerCase()) {
      throw new Error("Il package ricevuto dal browser non ha superato la verifica SHA-256");
    }

    const artifactRoot = resolve(process.env.NNM_ARTIFACT_ROOT ?? join(tmpdir(), "nnm-mcp-artifacts"));
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    const filename = safeArtifactName(artifact.filename);
    const path = input.destinationPath ? validateArtifactDestination(input.destinationPath, artifactRoot) : join(artifactRoot, `nnm-${safeArtifactName(input.jobId)}-${filename}`);
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("La destinazione dell'artefatto esiste già");
      throw new Error("Impossibile creare la destinazione dell'artefatto");
    }
    try {
      await handle.write(bytes);
      return { status: "ok", artifact: { kind: "wheel", path, mediaType: "application/octet-stream", bytes: bytes.length, sha256: artifact.sha256.toLowerCase() } };
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
  },
};

interface EditorWheelResponse {
  status?: string;
  artifact?: { filename: string; bytes: number; sha256: string; base64: string };
}

function safeArtifactName(value: string): string {
  const name = basename(value);
  if (!name || name === "." || name === ".." || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Nome artefatto non valido");
  return name;
}

function validateArtifactDestination(destinationPath: string, root: string): string {
  const path = resolve(destinationPath);
  if (!path.startsWith(`${root}/`) || safeArtifactName(basename(path)) !== basename(path)) throw new Error("La destinazione deve essere un file sicuro nella directory privata degli artefatti");
  return path;
}
