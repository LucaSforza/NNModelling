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
 * MCP Server Bootstrap — creates BrowserRPCClient,
 * registers all tools, and returns the MCP Server instance and context.
 *
 * This is the wiring hub of the NNModelling MCP server. It:
 *   1. Creates a BrowserRPCClient for browser communication
 *   2. Creates the MCP Server instance
 *   3. Registers all tools from tools/*.ts (iterates exports, finds {schema,handler} pairs)
 *   4. Implements ListToolsRequestSchema and CallToolRequestSchema
 *
 * The browser is the single source of truth for diagram state.
 * The server is a thin proxy — it sends RPC calls to the browser
 * and forwards results back to the LLM via MCP.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BrowserRPCClient } from "./browser-client.js";
import { RemoteTrainingClient } from "./remote-training.js";
import { z } from "zod";
import { MCPServerError } from "./errors.js";

// ── Import all tool modules ─────────────────────────────────────────────
// Each file exports multiple named tools (e.g. create_node, delete_nodes).
// We iterate over Object.entries to discover them automatically.
import * as graphTools from "./tools/graph.js";
import * as paramTools from "./tools/parameters.js";
import * as selectionTools from "./tools/selection.js";
import * as canvasTools from "./tools/canvas.js";
import * as validationTools from "./tools/validation.js";
import * as conversionTools from "./tools/conversion.js";
import * as inspectionTools from "./tools/inspection.js";
import * as lifecycleTools from "./tools/lifecycle.js";
import * as connectionTools from "./tools/connection.js";
import * as screenshotTools from "./tools/screenshot.js";
import * as remoteTrainingTools from "./tools/remote-training.js";
import * as projectTools from "./tools/project.js";

// ── ServerContext ───────────────────────────────────────────────────────

/**
 * Shared context object passed as the first argument to every MCP tool handler.
 * Provides access to:
 *   - browser:      BrowserRPCClient for sending RPC calls to the browser
 */
export interface ServerContext {
  browser: BrowserRPCClient;
  remoteTraining?: RemoteTrainingClient;
  projectRoot?: string;
}

export interface CreateServerOptions {
  wsPort?: number;
  backendUrl?: string;
  projectRoot?: string;
}

// ── Internal Types ──────────────────────────────────────────────────────

interface MCPToolEntry {
  schema: Record<string, unknown>;
  parse: (value: unknown) => Record<string, unknown>;
  handler: (ctx: ServerContext, input: Record<string, unknown>) => Promise<unknown>;
}

import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Discover tool entries from a module's named exports.
 *
 * Each tool file exports multiple named constants matching the pattern:
 * ```ts
 * export const tool_name = {
 *   schema: z.object({...}),
 *   async handler(ctx: ServerContext, input: ...) { ... }
 * };
 * ```
 *
 * This function iterates Object.entries and collects any value
 * that has both `schema` and `handler` properties.
 */
function discoverTools(module: Record<string, unknown>): Map<string, MCPToolEntry> {
  const tools = new Map<string, MCPToolEntry>();

  for (const [name, value] of Object.entries(module)) {
    if (
      value &&
      typeof value === "object" &&
      "schema" in (value as Record<string, unknown>) &&
      "handler" in (value as Record<string, unknown>)
    ) {
      const entry = value as { schema: unknown; handler: (ctx: ServerContext, input: Record<string, unknown>) => Promise<unknown> };
      tools.set(name, {
        schema: zodToJsonSchema(entry.schema as any),
        parse: (value: unknown) => (entry.schema as z.ZodTypeAny).parse(value) as Record<string, unknown>,
        handler: entry.handler,
      });
    }
  }

  return tools;
}

// ── createServer ────────────────────────────────────────────────────────

/**
 * Create and initialize the NNModelling MCP server.
 *
 * @returns An object with the MCP `Server` instance, shared `ServerContext`, and `BrowserRPCClient`.
 */
export async function createServer(
  options: CreateServerOptions = {},
): Promise<{ server: Server; ctx: ServerContext; browser: BrowserRPCClient }> {
  // The browser-owned package catalog is authoritative; the thin proxy keeps
  // no fallback copy that could drift from the live editor.
  const browser = new BrowserRPCClient({ port: options.wsPort });
  await browser.start();
  console.error("[nnmodelling-mcp] Browser WebSocket server ready");

  // ── Step 3: Build ServerContext ──────────────────────────────────────
  const ctx: ServerContext = {
    browser,
    remoteTraining: new RemoteTrainingClient(options.backendUrl),
    projectRoot: options.projectRoot,
  };

  // ── Step 4: Create MCP Server instance ──────────────────────────────
  const server = new Server(
    { name: "nnmodelling-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {} } }, // No resources capability
  );

  // ── Step 5: Register all tools ──────────────────────────────────────
  const toolRegistry = new Map<string, MCPToolEntry>();

  // Merge tools from all modules. Duplicate names are overwritten
  // (last module wins — none should collide across files).
  const allToolModules = [
    graphTools,
    paramTools,
    selectionTools,
    canvasTools,
    validationTools,
    conversionTools,
    inspectionTools,
    lifecycleTools,
    connectionTools,
    screenshotTools,
    remoteTrainingTools,
    projectTools,
  ] as Record<string, unknown>[];

  for (const module of allToolModules) {
    const discovered = discoverTools(module);
    for (const [name, entry] of discovered) {
      toolRegistry.set(name, entry);
    }
  }

  console.error(`[nnmodelling-mcp] Registered ${toolRegistry.size} tools`);

  // ── Step 6: ListTools handler ───────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = Array.from(toolRegistry.entries()).map(([name, tool]) => ({
      name,
      description: `NNModelling tool: ${name}`,
      inputSchema: tool.schema,
    }));

    return { tools };
  });

  // ── Step 7: CallTool handler ────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolRegistry.get(request.params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    try {
      let input: Record<string, unknown>;
      try {
        input = tool.parse(request.params.arguments ?? {});
      } catch (err) {
        if (err instanceof z.ZodError) {
          throw new MCPServerError("INVALID_ARGUMENT", err.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; "));
        }
        throw err;
      }
      const result = await tool.handler(ctx, input);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: unknown) {
      const typedErr = err as Record<string, unknown> | undefined;
      const error = typedErr?.code
        ? { code: typedErr.code as string, message: (typedErr.message as string) ?? "Unknown error", details: typedErr.details as Record<string, unknown> | undefined }
        : { code: "INTERNAL_ERROR", message: (err as Error)?.message ?? "Unknown error" };

      return {
        content: [{ type: "text", text: JSON.stringify({ error }) }],
        isError: true,
      };
    }
  });

  return { server, ctx, browser };
}
