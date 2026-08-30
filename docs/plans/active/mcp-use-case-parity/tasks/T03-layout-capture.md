---
id: T03
kind: task
status: draft
plan: ../plan.md
role: integration
depends_on: [T02]
parallel_with: []
write_scope:
  - front-end/src/FlowCanvas.svelte
  - front-end/src/Diagram.svelte.ts
  - front-end/src/sync/BrowserRPCHandler.ts
  - front-end/src/__tests__/
  - mcp-server/src/browser-client.ts
  - mcp-server/src/server.ts
  - mcp-server/src/tools/canvas.ts
  - mcp-server/src/tools/screenshot.ts
  - mcp-server/src/chromium-screenshot.ts
  - mcp-server/__tests__/
---

# Format and capture the selected browser diagram

## Objective

Satisfy M4–M5 with the actual Disponi operation and a screenshot of its rendered result.

## Context required

Read the [initiative plan](../plan.md), its source links and the
[accepted UML](../../../../knowledge/uml/mcp-use-case-parity.md).

Inspect `handleAutoLayout`, canvas synchronization, the ViewportController interface, RPC tab routing, capture target selection and T01's verified capture contract.

## Invariants

No alternate layout engine or guessed node coordinates. The screenshot workflow always lays out before capture, even if called directly. Browser screenshot is not canvas PNG export.

## Allowed files

- `front-end/src/FlowCanvas.svelte`
- `front-end/src/Diagram.svelte.ts`
- `front-end/src/sync/BrowserRPCHandler.ts`
- `front-end/src/__tests__/`
- `mcp-server/src/browser-client.ts`
- `mcp-server/src/server.ts`
- `mcp-server/src/tools/canvas.ts`
- `mcp-server/src/tools/screenshot.ts`
- `mcp-server/src/chromium-screenshot.ts`
- `mcp-server/__tests__/`

Directory scopes permit only changes serving this task. Narrow them to the
actual files in the handoff; do not reorganize unrelated modules.

## Out of scope

No new browser automation platform, image-generation substitute, graph layout algorithm or training work.

## Work

1. Expose horizontal/vertical layout through the existing diagram.autoLayout seam. Await actual Svelte/canvas synchronization and dimensions rather than an arbitrary sleep.
2. Bind the capture operation to the resolved RPC-selected tab and project for its whole duration. Reject tab loss or project replacement; never capture another matching URL.
3. Make capture invoke layout/readiness using explicit direction or the current editor direction. Integrate only the capture facility proven in T01; preserve supported full-page/hover options and avoid destructive reload shortcuts.
4. Return image content or the verified accessible image artifact defined in T01, with target and direction metadata. Distinguish unavailable capture capability from successful layout.
5. Report actual viewport state and await fit/center completion; missing controllers return an explicit unavailable error.
6. Add ordering, disconnect, unavailable-controller, hover, two-tab and both-direction regression tests.

## Acceptance criteria

- [ ] Direct capture demonstrably executes layout before visible capture in each direction.
- [ ] The image matches the selected tab and project; the other tab remains unchanged.
- [ ] Readiness and capability failures never return misleading success.
- [ ] Existing layout semantics, topology and viewport operations remain preserved.
- [ ] No changes outside the declared write scope.

## Validation

Run from the repository root. Extend the listed tests for the new behavior;
passing unchanged proxy mocks alone is not proof of this task.

```bash
pnpm --dir front-end exec vitest run src/__tests__/layout.test.ts src/__tests__/BrowserRPCHandler.test.ts
pnpm --dir front-end check
pnpm --dir mcp-server test
```

Use two disposable editor tabs, distinct diagrams and deliberately scrambled positions. Invoke public MCP format/capture for each direction, inspect resulting images, and compare with the actual Disponi button. Follow the repository browser skill; do not use an unsupported browser fallback.

## Required handoff

Return changed files, exact checks/results, observed user-facing behavior,
resolved assumptions, remaining blockers and affected KB statements. Keep
credentials out of evidence. Update this task's status in its own file; the
initiative plan owns overall status.

