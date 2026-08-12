# Undo/Redo System — Design Plan

> **Archive note (2026-08-12):** the original draft status below is retained
> for history. Snapshot-based undo/redo is implemented in `DiagramCore`; use
> the current code and package guidance as authority.

**Original status**: Draft
**Branch**: `undo-ops`
**Date**: 2026-07-03

---

## 1. Assessment: L'EventBus serve o no?

### Cosa hai chiesto

> Voglio un EventBus che gestisce la trasmissione di eventi. Poi quando avviene Ctrl+Z, prendere l'evento precedentemente accaduto e chiamare una funzione che ne faccia il revert.

### Cosa esiste già

L'`EventBus` (`core/EventBus.ts`, 66 righe) esiste già e funziona. Emette 12 tipi di `DomainEvent` su ogni mutazione di `DiagramCore`. È stato creato per la sincronizzazione real-time MCP server→browser (motivo sbagliato, come documentato in `overengineering.md`), ma è perfettamente riutilizzabile.

`DiagramCore` ha già:
- `getSnapshot(): DiagramCoreSnapshot` → serializza l'intero stato
- `restoreSnapshot(snapshot): void` → ripristina l'intero stato, emettendo `diagram_reset` sull'EventBus

### Verdetto: Approccio eventi individuali con revert → OVERENGINEERED

Associare una funzione di "revert" a ogni `DomainEvent` significherebbe:

1. **12 funzioni di revert diverse** — una per `node_created`, una per `node_deleted`, una per `edge_created`, ecc.
2. **Eventi non auto-sufficienti** — un `node_deleted` dice solo quali ID sono stati cancellati, ma per ripristinarli servirebbero posizione, params, stereotipo, edges collegati... informazioni che l'evento non contiene.
3. **Casi complessi** — `deleteNodes` cancella N nodi + M edges in un colpo solo. Il revert dovrebbe ricreare tutto l'insieme.
4. **Equivale a ricreare il Command Pattern** — complessità inutile quando `getSnapshot()`/`restoreSnapshot()` fanno già tutto in 2 chiamate.

### Raccomandazione: Snapshot-based undo/redo, EventBus come notifica

```
                        ┌──────────────────────────┐
                        │     UndoRedoManager       │
                        │                          │
                        │  undoStack: Snapshot[]    │
                        │  redoStack: Snapshot[]    │
                        │                          │
                        │  capture() → push current │
                        │  undo()    → pop + restore│
                        │  redo()    → pop + restore│
                        └──────────┬───────────────┘
                                   │ restoreSnapshot()
                                   ▼
                        ┌──────────────────────────┐
                        │     DiagramCore           │
                        │                          │
                        │  getSnapshot()  ← esiste │
                        │  restoreSnapshot() ← esiste│
                        │                          │
                        │  Ogni mutazione chiama   │
                        │  _captureUndoState()     │
                        └──────────┬───────────────┘
                                   │ emit diagram_reset
                                   ▼
                        ┌──────────────────────────┐
                        │     EventBus (esistente)  │
                        │                          │
                        │  Notifica subscriber      │
                        │  (MCP server, etc.)       │
                        └──────────────────────────┘

Svelte 5 $state.raw → re-rendering automatico
```

**Perché questo è meglio:**
- **30 righe di undo/redo logic** invece di 12 funzioni di revert
- **Nessun nuovo tipo di evento** da aggiungere all'EventBus
- **Correttezza garantita**: uno snapshot è lo stato completo, non può mancare nulla
- **Performance irrilevante**: un diagramma tipico ha ~20-100 nodi, uno snapshot sono pochi KB
- **Già testato**: `getSnapshot()`/`restoreSnapshot()` sono già usati dal MCP server e funzionano

---

## 2. Design

### 2.1 Cosa cambia

| File | Modifica | Righe nuove |
|------|----------|-------------|
| `core/DiagramCore.ts` | Aggiunge `_captureUndoState()` privato + `undo()`/`redo()` pubblici. Chiama `_captureUndoState()` all'inizio di ogni metodo di mutazione. | ~45 |
| `FlowCanvas.svelte` | Aggiunge `keydown` listener per Ctrl+Z / Ctrl+Alt+Z. | ~15 |
| **TOTALE** | | **~60 righe** |

Nessun file nuovo. Nessuna modifica all'EventBus. Nessuna modifica ai tipi.

### 2.2 DiagramCore — Aggiunte

```typescript
// In DiagramCore:
private _undoStack: DiagramCoreSnapshot[] = [];
private _redoStack: DiagramCoreSnapshot[] = [];
private _captureEnabled = true;  // disabilitato durante undo/redo per non ricatturare

private _captureUndoState(): void {
  if (!this._captureEnabled) return;
  this._undoStack.push(this.getSnapshot());
  if (this._undoStack.length > 50) this._undoStack.shift(); // limite memoria
  this._redoStack = []; // ogni nuova azione resetta il redo
}

undo(): boolean {
  if (this._undoStack.length === 0) return false;
  this._captureEnabled = false;
  this._redoStack.push(this.getSnapshot());
  this.restoreSnapshot(this._undoStack.pop()!);
  this._captureEnabled = true;
  return true;
}

redo(): boolean {
  if (this._redoStack.length === 0) return false;
  this._captureEnabled = false;
  this._undoStack.push(this.getSnapshot());
  this.restoreSnapshot(this._redoStack.pop()!);
  this._captureEnabled = true;
  return true;
}
```

### 2.3 Dove chiamare `_captureUndoState()`

All'inizio di **ogni metodo pubblico di mutazione** in `DiagramCore`:

| Metodo | Riga |
|--------|------|
| `addModule()` | `this._captureUndoState();` prima di `const newNode = ...` |
| `addJoinNode()` | `this._captureUndoState();` prima di `const id = ...` |
| `addSubGraph()` | `this._captureUndoState();` prima di `const id = ...` |
| `updateModule()` | `this._captureUndoState();` prima del `this.nodes = this.nodes.map(...)` |
| `deleteNodes()` | `this._captureUndoState();` prima del `const nodesToDelete = ...` |
| `deleteEdges()` | `this._captureUndoState();` prima del `this.edges = this.edges.filter(...)` |
| `deleteEdge()` | `this._captureUndoState();` prima del `this.edges = this.edges.filter(...)` |
| `addEdge()` | `this._captureUndoState();` prima della validazione |
| `removeEdge()` | `this._captureUndoState();` prima del `const removedEdges = ...` |
| `reconnectEdge()` | `this._captureUndoState();` prima del `this.edges = this.edges.map(...)` |
| `toggleSubflow()` | `this._captureUndoState();` all'inizio del metodo |
| `moveNode()` | `this._captureUndoState();` prima del `this.nodes = this.nodes.map(...)` |
| `moveNodes()` | `this._captureUndoState();` prima del `const posMap = ...` |
| `selectNodes()` | **NO** — la selezione non è una modifica strutturale |
| `clearSelection()` | **NO** — la selezione non è una modifica strutturale |
| `importFromJson()` | `this._captureUndoState();` prima del parsing |

Le operazioni **NON** coperte da undo (scelta intenzionale):
- `toggleSubflow` (collapse/expand) — è un cambio di visualizzazione, non strutturale
- `selectNodes` / `clearSelection` — non sono modifiche al grafo
- `moveNode` / `moveNodes` — opzionale, si può discutere se includerlo

**Decisione finale**: includiamo `toggleSubflow` e `moveNode`/`moveNodes` nell'undo. L'utente si aspetta che Ctrl+Z annulli l'ultima azione, qualsiasi essa sia. Escludiamo solo selezione e operazioni di serializzazione (export/import è già coperto).

### 2.4 FlowCanvas — Keyboard Shortcuts

```svelte
<!-- FlowCanvas.svelte, dentro <script> -->

function handleKeyDown(e: KeyboardEvent) {
  // Ctrl+Alt+Z = Redo (deve essere controllato prima di Ctrl+Z)
  if (e.ctrlKey && e.altKey && e.key === 'z') {
    e.preventDefault();
    diagram.redo();
    return;
  }
  // Ctrl+Z = Undo
  if (e.ctrlKey && e.key === 'z') {
    e.preventDefault();
    diagram.undo();
    return;
  }
}
```

Aggiungere `<svelte:window onkeydown={handleKeyDown} />` al template.

### 2.5 Flusso completo

```
Utente clicca "Elimina" su un nodo
  │
  ▼
FlowCanvas chiama diagram.deleteNodes(ids)
  │
  ▼
DiagramCore._captureUndoState()
  → getSnapshot() → push su undoStack
  → redoStack = []  (reset)
  │
  ▼
DiagramCore esegue la cancellazione
  → emit node_deleted, edge_deleted, graph_changed
  → $state.raw si aggiorna, UI re-render

Utente preme Ctrl+Z
  │
  ▼
FlowCanvas handleKeyDown → diagram.undo()
  │
  ▼
DiagramCore.undo()
  → _captureEnabled = false
  → redoStack.push(getSnapshot())  ← stato corrente (post-cancellazione)
  → restoreSnapshot(undoStack.pop())  ← stato precedente (pre-cancellazione)
  → _captureEnabled = true
  │
  ▼
restoreSnapshot emette diagram_reset
  → EventBus notifica subscriber
  → $state.raw si aggiorna, nodo riappare nell'UI

Utente preme Ctrl+Alt+Z (Redo)
  │
  ▼
DiagramCore.redo()
  → _captureEnabled = false
  → undoStack.push(getSnapshot())
  → restoreSnapshot(redoStack.pop())  ← stato post-cancellazione
  → _captureEnabled = true
  │
  ▼
Nodo scompare di nuovo
```

### 2.6 Perché il `_captureEnabled` flag è necessario

Senza il flag, `restoreSnapshot()` chiamato dentro `undo()` emetterebbe `diagram_reset`, e poi... niente verrebbe ricatturato perché `restoreSnapshot()` non chiama `_captureUndoState()`. Ma per sicurezza e chiarezza semantica, disabilitiamo esplicitamente la capture durante undo/redo.

Il flag evita anche che l'undo di un undo venga catturato come nuova azione (cosa che resetterebbe il redo stack).

---

## 3. Cosa NON facciamo

- **NON creiamo un nuovo EventBus** — usiamo quello esistente
- **NON aggiungiamo eventi "pre-mutation" o "before_change"** all'EventBus
- **NON aggiungiamo funzioni di revert agli eventi esistenti**
- **NON creiamo una classe `UndoRedoManager` separata** — la logica è minima e sta dentro `DiagramCore`
- **NON modifichiamo i tipi in `core/types.ts`** — `DiagramCoreSnapshot` esiste già
- **NON tocchiamo `BrowserRPCHandler`** — le sue mutazioni passano attraverso gli stessi metodi di `DiagramCore`, quindi l'undo le copre automaticamente
- **NON tocchiamo il server MCP** — l'undo/redo è una feature solo browser

---

## 4. Test Plan

### Unit test (`nnTree.test.ts` o nuovo `undoRedo.test.ts`)

1. **Undo dopo addModule**: crea nodo → undo → verifica che il nodo sia sparito
2. **Redo dopo undo**: crea nodo → undo → redo → verifica che il nodo sia riapparso
3. **Undo dopo deleteNodes**: crea 2 nodi → cancella → undo → verifica che entrambi siano tornati
4. **Redo stack reset**: crea nodo A → undo → crea nodo B → verifica che redo() fallisca (stack svuotato)
5. **Undo multiplo**: crea A, B, C → undo × 3 → verifica stato vuoto
6. **Limite 50 entry**: crea 55 nodi (azioni separate) → verifica che undoStack.length ≤ 50
7. **Undo dopo addEdge**: connetti due nodi → undo → verifica che l'edge sia sparito
8. **Undo dopo updateModule**: modifica parametri → undo → verifica parametri originali
9. **Undo dopo moveNode**: sposta nodo → undo → verifica posizione originale
10. **Undo dopo toggleSubflow**: collassa subflow → undo → verifica espanso

### Manual test (browser)

1. Apri l'app, crea qualche nodo, collegali
2. Ctrl+Z → undo, verifica che l'ultimo nodo/edge sparisca
3. Ctrl+Alt+Z → redo, verifica che riappaia
4. Fai 5 azioni, poi undo × 3, poi una nuova azione → verifica che il redo sia resettato

---

## 5. Tasks

| # | Task | Chi | File |
|---|------|-----|------|
| 1 | Backend: Aggiungere `_captureUndoState`, `undo()`, `redo()` a `DiagramCore` + chiamate `_captureUndoState()` in ogni metodo di mutazione | @backend | `core/DiagramCore.ts` |
| 2 | Frontend: Aggiungere keyboard listener in `FlowCanvas.svelte` per Ctrl+Z / Ctrl+Alt+Z | @frontend | `FlowCanvas.svelte` |
| 3 | Test: Scrivere unit test per undo/redo | @frontend | `__tests__/undoRedo.test.ts` |
| 4 | Review: Verificare l'implementazione completa | @reviewer | Tutti i file |

---

## 6. Riepilogo per approvazione

| Domanda | Risposta |
|---------|----------|
| Serve un EventBus per l'undo/redo? | Sì, ma solo come notifica (già esiste). Non serve associare revert a ogni evento. |
| Lo snapshot approach è sufficiente? | Sì. `getSnapshot()`/`restoreSnapshot()` già esistono e coprono ogni caso. |
| Quanto codice nuovo serve? | ~60 righe totali. Nessun file nuovo. |
| Si rompe qualcosa? | No. Le mutazioni esistenti continuano a funzionare identicamente. |
| L'MCP server è impattato? | No. Le mutazioni RPC passano attraverso gli stessi metodi di `DiagramCore`, quindi l'undo le copre automaticamente. |
