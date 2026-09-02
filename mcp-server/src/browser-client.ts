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

// mcp-server/src/browser-client.ts
// WebSocket RPC client — accepts multiple browser connections, provides
// promise-based request/response (not delta broadcast).
//
// Multi-tab: each browser tab gets a unique tab ID ("tab_1", "tab_2", …).
// The "active" tab receives all call() requests. The model can list tabs
// and select one via MCP tools.

import { WebSocketServer, WebSocket } from "ws";

interface RPCPending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ClientEntry {
  ws: WebSocket;
  connectedAt: number;
  nodeCount: number;
  edgeCount: number;
  pending: Map<string, RPCPending>;
  nextId: number;
}

export interface TabInfo {
  id: string;
  nodeCount: number;
  edgeCount: number;
  connectedAt: number;
}

export interface BrowserRPCClientConfig {
  host?: string;
  port?: number;
  requestTimeout?: number;
}
export type BrowserNotification = (tabId: string, method: string, params: Record<string, unknown>) => void | Promise<void>;

/**
 * BrowserRPCClient — WebSocket server that accepts multiple browser
 * connections (tabs) and provides a promise-based RPC interface.
 *
 * The browser connects TO this server. When an MCP tool is called via stdio,
 * the server sends an RPC request to the ACTIVE tab over the WebSocket.
 *
 * Protocol:
 *   Request:  {id: string, method: string, params: object}
 *   Response: {id: string, result: any}
 *   Error:    {id: string, error: {message: string}}
 *
 * Lifecycle:
 *   1. start() — opens WebSocket port, returns immediately (non-blocking)
 *   2. Browser connections register as tabs (auto-ping for nodeCount/edgeCount)
 *   3. call() sends RPC to the active tab (auto-selected for first tab)
 *   4. close() — shuts down server, rejects all pending
 */
export class BrowserRPCClient {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ClientEntry>();
  private activeTab: string | null = null;
  private tabCounter = 0;
  private host: string;
  private port: number;
  private requestTimeout: number;
  private readonly notificationListeners = new Set<BrowserNotification>();

  constructor(config?: BrowserRPCClientConfig) {
    this.host = config?.host ?? "localhost";
    this.port = config?.port ?? 9339;
    this.requestTimeout = config?.requestTimeout ?? 30000;
  }

  /**
   * Start the WebSocket server.
   * Returns a promise that resolves when the server is listening,
   * or rejects if the port is already in use (stale process).
   */
  start(): Promise<void> {
    if (this.wss) {
      return Promise.resolve(); // Already started
    }

    this.wss = new WebSocketServer({ host: this.host, port: this.port });

    return new Promise<void>((resolve, reject) => {
      this.wss!.on("listening", () => {
        console.error(
          `[browser-client] Listening on ws://${this.host}:${this.port}`,
        );
        resolve();
      });

      this.wss!.on("error", (err: Error) => {
        const msg = err.message.toLowerCase();
        if (msg.includes("eaddrinuse")) {
          reject(
            new Error(
              `Port ${this.port} already in use — another MCP server instance may be running. ` +
              `Kill the stale process (PID matching ${this.port}) and restart.`,
            ),
          );
        } else {
          reject(new Error(`WebSocket server error: ${err.message}`));
        }
      });

      this.wss!.on("connection", (ws: WebSocket) => {
        this.handleConnection(ws);
      });
    });
  }

  /** Close the WebSocket server, disconnect all tabs, reject pending. */
  async close(): Promise<void> {
    const wss = this.wss;
    if (!wss) return;

    // Clear the reference first so repeated close() calls are harmless and a
    // later start() can create a fresh listener.
    this.wss = null;

    for (const [, entry] of this.clients) {
      this.rejectAll(entry, new Error("Server shutting down"));
      entry.ws.terminate();
    }
    this.clients.clear();
    this.activeTab = null;

    await new Promise<void>((resolve, reject) => {
      wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Send an RPC request to the active tab and await the response.
   * @param method  The RPC method name (e.g. "get_graph").
   * @param params  Optional parameters for the method.
   * @returns The browser's response (decoded from JSON).
   * @throws If no active tab is connected.
   */
  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.activeTab) {
      return Promise.reject(new Error("No browser connected"));
    }

    const entry = this.clients.get(this.activeTab);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("No browser connected"));
    }

    const id = String(++entry.nextId);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, this.requestTimeout);

      entry.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      entry.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  /** Check if an active tab is selected and its WebSocket is open. */
  isConnected(): boolean {
    if (!this.activeTab) return false;
    const entry = this.clients.get(this.activeTab);
    return entry !== undefined && entry.ws.readyState === WebSocket.OPEN;
  }

  /** Get info about all currently connected browser tabs. */
  getTabs(): TabInfo[] {
    const tabs: TabInfo[] = [];
    for (const [id, entry] of this.clients) {
      tabs.push({
        id,
        nodeCount: entry.nodeCount,
        edgeCount: entry.edgeCount,
        connectedAt: entry.connectedAt,
      });
    }
    return tabs;
  }

  /** Set which tab subsequent call() requests go to. */
  selectTab(id: string): void {
    if (!this.clients.has(id)) {
      throw new Error(`Tab '${id}' not found`);
    }
    this.activeTab = id;
  }

  /** Get the active tab ID, or null if none selected. */
  getActiveTabId(): string | null {
    return this.activeTab;
  }

  onNotification(listener: BrowserNotification): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  // ── Private ────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    this.tabCounter++;
    const tabId = `tab_${this.tabCounter}`;
    const connectedAt = Date.now();

    console.error(`[browser-client] Browser tab connected: ${tabId}`);

    const entry: ClientEntry = {
      ws,
      connectedAt,
      nodeCount: 0,
      edgeCount: 0,
      pending: new Map(),
      nextId: 0,
    };

    this.clients.set(tabId, entry);

    // Auto-select the first tab that connects
    if (this.clients.size === 1) {
      this.activeTab = tabId;
      console.error(`[browser-client] Auto-selected tab: ${tabId}`);
    }

    ws.on("message", (data: Buffer) => {
      this.onMessage(tabId, data.toString());
    });

    ws.on("close", () => {
      console.error(`[browser-client] Browser tab disconnected: ${tabId}`);
      this.clients.delete(tabId);

      if (this.activeTab === tabId) {
        this.activeTab = null;
        console.error("[browser-client] Active tab disconnected — no tab selected");
      }

      this.rejectAll(entry, new Error("Browser disconnected"));
    });

    ws.on("error", (err: Error) => {
      console.error(
        `[browser-client] WebSocket error (${tabId}):`,
        err.message,
      );
    });

    // Send initial ping to populate nodeCount/edgeCount for tab summary
    this.sendPing(tabId, entry);
  }

  private sendPing(tabId: string, entry: ClientEntry): void {
    const id = String(++entry.nextId);
    const timer = setTimeout(() => {
      entry.pending.delete(id);
    }, this.requestTimeout);

    entry.pending.set(id, {
      resolve: (result: unknown) => {
        const r = result as { nodeCount?: number; edgeCount?: number } | undefined;
        if (r) {
          entry.nodeCount = r.nodeCount ?? 0;
          entry.edgeCount = r.edgeCount ?? 0;
        }
      },
      reject: () => {
        // Initial ping failed — not critical, nodeCount/edgeCount stay 0
      },
      timer,
    });

    try {
      entry.ws.send(JSON.stringify({ id, method: "ping", params: {} }));
    } catch {
      entry.pending.delete(id);
      clearTimeout(timer);
    }
  }

  private onMessage(tabId: string, data: string): void {
    let msg: { id?: string; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(data);
    } catch {
      return; // Ignore non-JSON messages
    }

    if (!msg.id) {
      const notification = msg as unknown as { method?: unknown; params?: unknown };
      if (typeof notification.method === "string" && notification.params && typeof notification.params === "object") {
        for (const listener of this.notificationListeners) void listener(tabId, notification.method, notification.params as Record<string, unknown>);
      }
      return;
    }

    const entry = this.clients.get(tabId);
    if (!entry) return;

    const pending = entry.pending.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    entry.pending.delete(msg.id);

    if (msg.error) {
      pending.reject(new Error(msg.error.message));
    } else {
      pending.resolve(msg.result);
    }
  }

  private rejectAll(entry: ClientEntry, err: Error): void {
    for (const [, p] of entry.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    entry.pending.clear();
  }
}
