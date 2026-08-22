#!/usr/bin/env node
/**
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
 *
 * NNModelling MCP Server — Entry Point
 *
 * Bootstraps the MCP server (stdio transport). The MCP server handles
 * tool/resource requests from LLM agents and communicates with the browser
 * via WebSocket RPC through the BrowserRPCClient.
 *
 * Usage:
 *   node dist/index.js
 *
 * Environment variables:
 *   NNM_WS_PORT    — WebSocket server port (default: 9339)
 *   NNM_CDP_URL     — Chromium DevTools HTTP URL (default: http://127.0.0.1:9223)
 *   NNM_FRONTEND_URL — Preferred frontend page URL for screenshots
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

function parseWebSocketPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid NNM_WS_PORT '${value}'`);
  }

  return port;
}

async function main(): Promise<void> {
  console.error("[nnmodelling-mcp] Starting server...");

  // ── Create the MCP server with full tool/resource registration ──────
  const wsPort = parseWebSocketPort(process.env.NNM_WS_PORT);
  const { server, browser } = await createServer({ wsPort });

  // ── Connect stdio transport (MCP protocol) ─────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[nnmodelling-mcp] Server connected via stdio");

  // ── Graceful shutdown ──────────────────────────────────────────────
  let shuttingDown = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.error(`[nnmodelling-mcp] Shutting down (${reason})...`);

    // Close browser WebSocket connection
    try {
      await browser.close();
    } catch (err) {
      console.error("[nnmodelling-mcp] Browser WebSocket close error:", err);
    }

    // Close MCP server (returns Promise<void>)
    try {
      await server.close();
    } catch (err) {
      console.error("[nnmodelling-mcp] MCP server close error:", err);
    }

    process.exitCode = 0;
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.stdin.once("end", () => void shutdown("stdin ended"));
  process.stdin.once("close", () => void shutdown("stdin closed"));
}

main().catch((err: unknown) => {
  console.error("[nnmodelling-mcp] Fatal error:", err);
  process.exit(1);
});
