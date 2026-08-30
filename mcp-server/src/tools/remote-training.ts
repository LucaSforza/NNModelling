/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 */

/** Optional MCP proxy tools for the FastAPI remote-training backend. */

import { z } from "zod";
import type { ServerContext } from "../server.js";
import { RemoteTrainingClient } from "../remote-training.js";

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
