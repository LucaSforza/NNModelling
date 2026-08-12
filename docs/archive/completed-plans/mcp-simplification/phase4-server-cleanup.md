# Phase 4: Finalize server.ts cleanup

## Objective
Remove remaining dead code: delete `transaction.ts` and `history.ts`, add `browser.connect()` call, replace custom `zodToJsonSchema` with npm package.

## Files

| File | Action |
|---|---|
| `mcp-server/src/transaction.ts` | **DELETE** |
| `mcp-server/src/history.ts` | **DELETE** |
| `mcp-server/src/server.ts` | **MODIFY** — add connect, replace zodToJsonSchema |
| `mcp-server/src/index.ts` | **MODIFY** — add BrowserRPCClient shutdown |
| `mcp-server/package.json` | **MODIFY** — add `zod-to-json-schema` dep |

## Spec

### server.ts changes

1. Replace custom `zodToJsonSchema` (lines 62-134) with:
```typescript
import { zodToJsonSchema } from "zod-to-json-schema";
```

2. In `createServer`, after creating `BrowserRPCClient`, add connection:
```typescript
console.error("[nnmodelling-mcp] Waiting for browser connection...");
await browser.connect();
console.error("[nnmodelling-mcp] Browser connected");
```

3. Export the `browser` instance so `index.ts` can shut it down:
```typescript
return { server, ctx, browser };
```

### index.ts changes

Add browser shutdown before server close:
```typescript
const shutdown = async (): Promise<void> => {
  console.error("[nnmodelling-mcp] Shutting down...");
  browser.close();
  try { await server.close(); } catch (err) { ... }
  process.exit(0);
};
```

Destructure `browser` from `createServer`:
```typescript
const { server, ctx, browser } = await createServer(stereotypesDir);
```

### package.json change

Add dependency:
```bash
cd mcp-server && pnpm add zod-to-json-schema
```

## Verification
```bash
cd mcp-server && npx tsc --noEmit
```
