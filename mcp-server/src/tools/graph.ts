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
 * Graph Manipulation Tools — thin browser-RPC proxies.
 *
 * Every handler delegates to the browser via ctx.browser.call().
 * The browser's DiagramCore is the single source of truth.
 */

import { z } from "zod";
import type { ServerContext } from "../server";

// ── Schemas ────────────────────────────────────────────────────────────

export const create_node = {
  schema: z.object({
    package: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      name: z.string().min(1),
      kind: z.enum(["input", "layer", "loss", "join", "subflow", "output"]),
    }).optional(),
    position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
    parameters: z.record(z.string(), z.unknown()).optional(),
    name: z.string().optional(),
    color: z.string().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    inputsCount: z.number().int().min(1).optional(),
    parentId: z.string().min(1).optional(),
    wheelAdapters: z.array(z.string().min(1)).optional(),
  }).refine((value) => Boolean(value.package), {
    message: "create_node requires package {id, version, name, kind}; legacy stereotype input is unsupported",
  }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("create_node", input);
  },
};

export const delete_nodes = {
  schema: z.object({ nodeIds: z.array(z.string()).min(1) }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("delete_nodes", input);
  },
};

export const connect_nodes = {
  schema: z.object({
    source: z.string().min(1),
    target: z.string().min(1),
    sourceHandle: z.string().optional(),
    targetHandle: z.string().optional(),
  }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("connect_nodes", input);
  },
};

export const disconnect_nodes = {
  schema: z.object({
    source: z.string().min(1),
    target: z.string().min(1),
    targetHandle: z.string().optional(),
  }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("disconnect_nodes", input);
  },
};

export const move_nodes = {
  schema: z.object({
    positions: z
      .array(z.object({ id: z.string(), x: z.number(), y: z.number() }))
      .min(1),
  }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("move_nodes", input);
  },
};

export const duplicate_nodes = {
  schema: z.object({
    nodeIds: z.array(z.string()).min(1),
    offset: z.object({ x: z.number(), y: z.number() }).optional(),
  }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("duplicate_nodes", input);
  },
};

export const create_subflow = {
  schema: z.object({
    position: z.object({ x: z.number(), y: z.number() }),
    label: z.string().optional(),
  }),

  async handler(ctx: ServerContext, input: z.infer<typeof this.schema>) {
    return ctx.browser.call("create_subflow", input);
  },
};
