# Frontend Task 1: Add keyboard shortcuts for undo/redo

**Objective**: Add keyboard listener in `FlowCanvas.svelte` to handle Ctrl+Z (undo) and Ctrl+Alt+Z (redo).

**File to modify**: `front-end/src/FlowCanvas.svelte`

**No new files.**

---

## 1. Add the keyboard handler function

Add this function inside the `<script>` block (e.g., after line 86, after the `$effect` for `BrowserRPCHandler`):

```typescript
function handleKeyDown(e: KeyboardEvent) {
  // Ignore if user is typing in an input/textarea
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
    return;
  }

  // Ctrl+Alt+Z = Redo (check BEFORE Ctrl+Z to avoid conflict)
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

## 2. Add the event listener to the window

Add this at the end of the template (after the `</style>` tag is fine, but inside `<script>` is better — actually, use Svelte's `<svelte:window>` directive):

Add this line inside the `<div class="editor-layout">` at the top (after line 166, before the canvas-container div):

```svelte
<svelte:window onkeydown={handleKeyDown} />
```

## 3. Verify

After implementation:
1. Press Ctrl+Z on the page — verify the last action is undone
2. Press Ctrl+Alt+Z — verify the undo is redone
3. Type in an input field (e.g., sidebar) and press Ctrl+Z — verify it does NOT trigger diagram undo
4. Verify the keyboard shortcuts don't interfere with browser's native Ctrl+Z in text fields
