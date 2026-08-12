# Phase 2: Server WebSocket RPC Client

## Objective
Replace `mcp-server/src/ws-server.ts` (267 lines of delta broadcast + domain event conversion) with `mcp-server/src/browser-client.ts` (~100 lines of promise-based request/response).

## Protocol

The server is the **requestor**, the browser is the **responder**. Both share the same WebSocket connection (browser connects to server's port). The server sends `{id, method, params}` and the browser responds `{id, result}` or `{id, error}`.

## Files

| File | Action |
|---|---|
| `mcp-server/src/browser-client.ts` | **CREATE** — WebSocket RPC client |
| `mcp-server/src/ws-server.ts` | **DELETE** |

## Spec: browser-client.ts

```typescript
/**
 * BrowserRPCClient — WebSocket-based RPC client.
 *
 * Connects to the browser's WebSocket server port (9339 by default).
 * Provides a promise-based `call(method, params)` interface. Each call
 * sends a {id, method, params} request and returns a Promise that resolves
 * with the browser's response or rejects on timeout/error.
 *
 * @module browser-client
 */

import { WebSocket } from "ws";

interface RPCPending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserRPCClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, RPCPending>();
  private nextId = 0;
  private url: string;
  private requestTimeout: number;

  constructor(options?: { host?: string; port?: number; timeout?: number }) {
    const host = options?.host ?? "localhost";
    const port = options?.port ?? 9339;
    this.url = `ws://${host}:${port}`;
    this.requestTimeout = options?.timeout ?? 30000;
  }

  /** Connect to the browser's WebSocket server. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on("open", () => {
        console.error(`[browser-client] Connected to ${this.url}`);
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.onMessage(data.toString());
      });

      this.ws.on("close", () => {
        console.error("[browser-client] Connection closed");
        this.rejectAll(new Error("Connection closed"));
      });

      this.ws.on("error", (err: Error) => {
        console.error("[browser-client] WebSocket error:", err.message);
        reject(err);
      });

      // Timeout the connection attempt after 10s
      setTimeout(() => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          reject(new Error("Connection timeout"));
        }
      }, 10000);
    });
  }

  /** Close the WebSocket connection. */
  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Send an RPC request to the browser and await the response.
   * @param method  The RPC method name (e.g. "get_graph", "create_node").
   * @param params  Optional parameters for the method.
   * @returns The browser's response (decoded from JSON).
   */
  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected to browser"));
    }

    const id = String(++this.nextId);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, this.requestTimeout);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });

      this.ws!.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  /** Check if the connection is open. */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ── Private ────────────────────────────────────────────────────────

  private onMessage(data: string): void {
    let msg: { id?: string; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(data);
    } catch {
      return; // Ignore non-JSON messages
    }

    if (!msg.id) return;

    const pending = this.pending.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(msg.id);

    if (msg.error) {
      pending.reject(new Error(msg.error.message));
    } else {
      pending.resolve(msg.result);
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
```

## Spec: index.ts changes

Update `mcp-server/src/index.ts` to use `BrowserRPCClient` instead of `createWSServer`:

```typescript
// OLD:
import { createWSServer, type WSServer } from "./ws-server";
const wss = createWSServer(ctx.diagram, ctx.diagram.events, { port: wsPort });

// NEW:
// WebSocket server is now just a pass-through — the browser connects to it,
// and the BrowserRPCClient is created inside createServer and attached to ctx.
// index.ts no longer needs to create or manage the WS server directly.
// The WS server runs inside the new BrowserRPCClient (or remains minimal).
```

Actually, there's a design question here: the **browser connects to the server's WebSocket**. The server needs a `ws.WebSocketServer` to accept browser connections. But in the new architecture, the server needs to:
1. Accept browser WebSocket connections
2. Use the browser connection for RPC calls

The `BrowserRPCClient` wraps a single connection. But the `ws.WebSocketServer` can have multiple connections. For simplicity, we can keep a thin WebSocket server in `browser-client.ts` that:
1. Listens on port 9339
2. Accepts one browser connection (or the first one)
3. Exposes that connection for RPC via `call()`

Let me update the spec to handle this:

```typescript
export class BrowserRPCClient {
  private wss: ws.WebSocketServer;
  private client: WebSocket | null = null;
  // ...

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new ws.WebSocketServer({ host: this.host, port: this.port });
      
      this.wss.on("connection", (ws) => {
        if (this.client) {
          ws.close(1013, "Only one browser connection allowed");
          return;
        }
        this.client = ws;
        ws.on("message", (data) => this.onMessage(data.toString()));
        ws.on("close", () => { this.client = null; this.rejectAll(new Error("Browser disconnected")); });
        console.error("[browser-client] Browser connected");
        resolve();
      });

      this.wss.on("error", (err) => reject(err));
      
      // Timeout
      setTimeout(() => {
        if (!this.client) reject(new Error("Timeout waiting for browser connection"));
      }, this.connectionTimeout);
    });
  }
}
```

This keeps the WebSocket server but makes it dead simple: just accept one browser, relay RPC messages.

## Test Plan
- Unit test: mock WebSocket, verify `call()` returns promise that resolves on response
- Integration test: connect BrowserRPCClient, send request, verify browser responds
