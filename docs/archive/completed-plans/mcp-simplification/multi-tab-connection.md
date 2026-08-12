# Multi-Tab Connection Management

## Problem

`BrowserRPCClient` accetta una sola connessione browser e blocca `createServer()` in attesa. Due problemi:

1. **Blocco startup**: `await browser.connect()` blocca il wiring del transport MCP finché un browser non si connette. Il server deve partire subito.
2. **Multi-tab**: Da `localhost:5173` posso aprire N tab con diagrammi diversi. Il modello deve poter scegliere con quale lavorare.

## Design

```
Server (porta 9339)
  │
  ├── tab_1 (ws) ─── Browser Tab #1 (diagramma A, 5 nodi)
  ├── tab_2 (ws) ─── Browser Tab #2 (diagramma B, 12 nodi)
  └── tab_3 (ws) ─── Browser Tab #3 (diagramma C, 0 nodi)

  activeTabId: "tab_2"   ← selezionato dal modello
```

### BrowserRPCClient — nuova API

```typescript
class BrowserRPCClient {
  // ── Lifecycle ──
  start(): void                              // avvia il server WebSocket, NON blocking
  close(): void                              // chiude il server

  // ── RPC ──
  call<T>(method: string, params): Promise<T> // invia RPC al tab attivo, reject se nessuno
  isConnected(): boolean                      // true se activeTabId !== null

  // ── Multi-tab ──
  getTabs(): TabInfo[]                        // lista tab connessi
  selectTab(id: string): void                 // imposta activeTabId
  getActiveTabId(): string | null
}

interface TabInfo {
  id: string;            // "tab_1", "tab_2", ...
  nodeCount: number;     // da ping iniziale
  edgeCount: number;     // da ping iniziale
  connectedAt: number;   // timestamp
}
```

**start() vs connect()**: `start()` apre la porta e torna subito. Non aspetta browser. Ogni tab che si connette viene registrato in `clients: Map<string, ClientEntry>`. `call()` lavora su `activeTabId` e rejecta se è null.

**Auto-selezione**: quando il primo tab si connette → `activeTabId = tab.id` automaticamente. Quando se ne connette un secondo → niente auto-selezione, il modello usa `list_browser_tabs`.

### Nuovi MCP tools

File: `mcp-server/src/tools/connection.ts`

```typescript
export const list_browser_tabs = {
  schema: z.object({}),
  async handler(ctx: ServerContext) {
    return {
      tabs: ctx.browser.getTabs(),
      activeTabId: ctx.browser.getActiveTabId(),
    };
  },
};

export const select_browser_tab = {
  schema: z.object({ tabId: z.string().min(1) }),
  async handler(ctx: ServerContext, input) {
    if (!ctx.browser.getTabs().find(t => t.id === input.tabId)) {
      throw new Error(`Tab '${input.tabId}' not found. Use list_browser_tabs to see available tabs.`);
    }
    ctx.browser.selectTab(input.tabId);
    return { success: true, selectedTab: input.tabId };
  },
};
```

### ServerContext

```typescript
export interface ServerContext {
  browser: BrowserRPCClient;
  pipeline: typeof pipelineMod;
  stereotypes: StereotypeCore[];
}
```

(Nessun `activeTabId` esplicito — è interno a `BrowserRPCClient`)

### server.ts — createServer()

```typescript
export async function createServer(stereotypesDir: string) {
  const stereotypes = loadStereotypesFromDirectory(stereotypesDir);

  const browser = new BrowserRPCClient();
  browser.start();  // NON blocking — apre la porta e torna subito

  const ctx: ServerContext = { browser, pipeline: pipelineMod, stereotypes };

  // ... tool discovery, MCP server setup ...

  return { server, ctx, browser };
}
```

### index.ts — shutdown

```typescript
const { server, ctx, browser } = await createServer(stereotypesDir);
// ... stdio transport ...

const shutdown = async () => {
  browser.close();
  await server.close();
  process.exit(0);
};
```

### Browser-side (nessuna modifica)

`BrowserRPCHandler` non cambia. Ogni tab ha il suo `DiagramCore` indipendente e risponde alle RPC in autonomia. Il server non sa nulla dello stato del diagramma — lo interroga solo quando serve.

## Flusso d'uso tipico

```
1. Utente apre localhost:5173 → tab_1 si connette, auto-selezionato
2. Modello: get_graph → restituisce il grafico di tab_1 ✓
3. Utente apre un secondo tab → tab_2 si connette
4. Modello: list_browser_tabs → { tabs: [tab_1, tab_2], activeTabId: "tab_1" }
5. Modello chiede all'utente: "Quale tab vuoi usare?"
6. Utente: "tab_2"
7. Modello: select_browser_tab("tab_2") → { success: true }
8. Modello: get_graph → ora restituisce il grafico di tab_2 ✓
```

## Cosa non cambia

- `BrowserRPCHandler.ts` — invariato
- Tutti i tool esistenti — invariati, continuano a chiamare `ctx.browser.call()` che ora rutta al tab selezionato
- `core/` — invariato
- `pipeline.ts` — invariato
- `errors.ts` — invariato
