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
 * Diagram Inspection Tools — thin browser-RPC proxies.
 *
 * All tools delegate to the browser via ctx.browser.call(). The browser-owned
 * package catalog is the only authority for available stereotypes.
 */

import { z } from "zod";
import type { ServerContext } from "../server";

// ── Tools ──────────────────────────────────────────────────────────────

export const get_graph = {
  schema: z.object({}),

  async handler(ctx: ServerContext, _input: z.infer<typeof this.schema>) {
    return ctx.browser.call("get_graph", {});
  },
};

export const get_node = {
  schema: z.object({ nodeId: z.string().min(1) }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("get_node", input);
  },
};

export const get_type_info = {
  schema: z.object({
    nodeId: z.string().min(1).optional(),
    refresh: z.boolean().optional(),
  }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("get_type_info", input);
  },
};

export const get_edges = {
  schema: z.object({ nodeId: z.string().optional() }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("get_edges", input);
  },
};

export const get_subflow = {
  schema: z.object({ parentId: z.string().min(1) }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("get_subflow", input);
  },
};

export const graph_statistics = {
  schema: z.object({}),

  async handler(ctx: ServerContext, _input: z.infer<typeof this.schema>) {
    return ctx.browser.call("graph_statistics", {});
  },
};

export const list_stereotypes = {
  schema: z.object({ category: z.string().optional() }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("list_stereotypes", input);
  },
};

/** Retrieve browser-owned fatal package/runtime diagnostics verbatim. */
export const get_package_diagnostics = {
  schema: z.object({}),

  async handler(ctx: ServerContext, _input: z.infer<typeof this.schema>) {
    return ctx.browser.call("get_package_diagnostics", {});
  },
};
