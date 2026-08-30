/*
 * NNModelling — DSL for designing neural networks via visual node editor
 * Copyright (C) 2026  Luca Sforza
 *
 * Licensed under the GNU General Public License v3 or later.
 * Commercial licenses are available — contact Luca Sforza.
 * See the LICENSE file for details.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 */

/**
 * Parameter Manipulation Tools — thin browser-RPC proxies.
 *
 * Every handler delegates to the browser via ctx.browser.call().
 * The browser's DiagramCore validates parameters against stereotype defs.
 */

import { z } from "zod";
import type { ServerContext } from "../server";

// ── Schemas ────────────────────────────────────────────────────────────

export const set_parameter = {
  schema: z.object({
    nodeId: z.string().min(1),
    key: z.string().min(1),
    value: z.unknown(),
  }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("set_parameter", input);
  },
};

export const update_parameters = {
  schema: z.object({
    nodeId: z.string().min(1),
    params: z.record(z.string(), z.unknown()),
  }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("update_parameters", input);
  },
};

export const reset_parameters = {
  schema: z.object({
    nodeId: z.string().min(1),
    keys: z.array(z.string().min(1)).optional(),
  }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("reset_parameters", input);
  },
};

export const query_parameters = {
  schema: z.object({
    nodeId: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("query_parameters", input);
  },
};
