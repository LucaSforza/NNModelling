# Backend Task 1: Add undo/redo to DiagramCore

**Objective**: Add `_captureUndoState()`, `undo()`, `redo()` to `DiagramCore`, with a `_captureUndoState()` call at the start of every mutation method.

**File to modify**: `front-end/src/core/DiagramCore.ts`

**No new files. No changes to EventBus. No changes to core/types.ts.**

---

## 1. Add to the class body (after line 15 `public readonly events: EventBus;`)

```typescript
// ── Undo/Redo ──────────────────────────────────────────────────
private _undoStack: DiagramCoreSnapshot[] = [];
private _redoStack: DiagramCoreSnapshot[] = [];
private _captureEnabled = true;

private _captureUndoState(): void {
  if (!this._captureEnabled) return;
  this._undoStack.push(this.getSnapshot());
  // Limit stack size to prevent memory issues
  if (this._undoStack.length > 50) this._undoStack.shift();
  // New action clears redo history
  this._redoStack = [];
}

/** Undo the last mutation. Returns true if an undo was performed. */
public undo(): boolean {
  if (this._undoStack.length === 0) return false;
  this._captureEnabled = false;
  this._redoStack.push(this.getSnapshot());
  this.restoreSnapshot(this._undoStack.pop()!);
  this._captureEnabled = true;
  return true;
}

/** Redo the last undone mutation. Returns true if a redo was performed. */
public redo(): boolean {
  if (this._redoStack.length === 0) return false;
  this._captureEnabled = false;
  this._undoStack.push(this.getSnapshot());
  this.restoreSnapshot(this._redoStack.pop()!);
  this._captureEnabled = true;
  return true;
}
```

Place this after the constructor (after line 33) and before `initStereotypes`.

## 2. Add `this._captureUndoState();` at the START of every mutation method

**IMPORTANT**: The call must be the VERY FIRST line of the method body (after the signature but before any logic). This ensures the snapshot captures state BEFORE any changes.

Insert `this._captureUndoState();` as the first line in these methods:

| Method | Line to insert before |
|--------|----------------------|
| `addModule()` (line 66) | Before `let finalName = customConfig?.name;` |
| `addJoinNode()` (line 119) | Before `const id = ...` |
| `addSubGraph()` (line 148) | Before `const id = ...` |
| `updateModule()` (line 181) | Before `const changes: Record<string, unknown> = {};` |
| `deleteNodes()` (line 223) | Before `const nodesToDelete = new Set(ids);` |
| `deleteEdges()` (line 280) | Before `this.edges = this.edges.filter(...)` |
| `deleteEdge()` (line 289) | Before `this.edges = this.edges.filter(...)` |
| `addEdge()` (line 401) | Before `const validation = coreCheckValidConnection(...)` |
| `removeEdge()` (line 430) | Before `const removedEdges = this.edges.filter(...)` |
| `reconnectEdge()` (line 453) | Before `this.edges = this.edges.map(...)` |
| `toggleSubflow()` (line 298) | Before `for (const child of ...)` |
| `moveNode()` (line 482) | Before `this.nodes = this.nodes.map(...)` |
| `moveNodes()` (line 493) | Before `const posMap = new Map(...)` |
| `importFromJson()` (line 567) | Before `try { const parsedData = ...` |

**DO NOT add** `_captureUndoState()` to:
- `selectNodes()` — selection is not a structural change
- `clearSelection()` — selection is not a structural change
- `exportToJson()` — read-only
- `getSnapshot()` / `restoreSnapshot()` — would create infinite loops
- `undo()` / `redo()` — already handled by `_captureEnabled` flag
- Query methods: `getNodeById()`, `getChilds()`, `getParents()`, `getStereotype()`

## 3. Verify

After implementation, verify:
1. `undo()` returns `false` when stack is empty
2. `redo()` returns `false` when stack is empty
3. Both methods correctly toggle `_captureEnabled`
4. `_captureUndoState` resets `_redoStack` on new capture
5. Maximum undo stack is 50
6. All 14 mutation methods have the `_captureUndoState()` call
