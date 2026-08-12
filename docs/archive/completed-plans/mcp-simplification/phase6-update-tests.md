# Phase 6: Update Tests

## Objective
Update MCP server tests to work with the new BrowserRPCClient-based architecture. Remove tests for deleted code.

## Files

| File | Action |
|---|---|
| `mcp-server/__tests__/tools.test.ts` | **REWRITE** — mock BrowserRPCClient instead of creating DiagramCore |
| `mcp-server/__tests__/websocket.test.ts` | **REWRITE** — test RPC protocol, not delta protocol |
| `mcp-server/__tests__/integration.test.ts` | **CHECK** — if it tests server-side state, update or delete |
| `front-end/src/__tests__/DiagramSyncClient.test.ts` | already deleted in Phase 1 |

## Spec: tools.test.ts

Instead of creating a full `DiagramCore` with stereotypes, create a mock `BrowserRPCClient`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ServerContext } from "../src/server";
import type { BrowserRPCClient } from "../src/browser-client";

function createMockBrowser(): BrowserRPCClient {
  const mock = {
    call: vi.fn().mockResolvedValue({}),
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
  return mock as unknown as BrowserRPCClient;
}

function createTestContext(): ServerContext {
  return {
    browser: createMockBrowser(),
    pipeline: null as any,
    stereotypes: [],
  };
}
```

Each test sets up `mockBrowser.call.mockResolvedValue(expectedResult)` before calling the tool handler, then verifies:
1. `mockBrowser.call` was called with the correct method name and params
2. The returned result matches expected

## Spec: websocket.test.ts

Test the `BrowserRPCClient` class:
- `connect()` waits for browser WebSocket connection
- `call()` sends `{id, method, params}` and resolves with `{id, result}`
- `call()` rejects on timeout
- `call()` rejects on error response `{id, error: {message}}`
- `close()` shuts down server

## Verification
```bash
cd mcp-server && npx vitest run
cd front-end && npm run test
```
