---
id: T09
kind: task
status: complete
plan: ../plan.md
role: verification
depends_on:
  - T05
  - T06
  - T07
  - T08
parallel_with: []
write_scope:
  - front-end/src/__tests__/
  - front-end/tests/fixtures/packages/
  - docs/knowledge/contracts/package-type-system.md
  - docs/knowledge/architecture/overview.md
  - docs/archive/completed-plans/cordis-runtime-and-external-packages/
---

# Verify the complete browser and MCP package flow

## Objective

Prove the initiative through the real editor and browser-backed MCP interface,
run package gates, update current knowledge to match verified behavior, and
archive the completed plan without expanding scope.

## Context required

- every prior task handoff and current diff
- `.agents/skills/nnmodelling-mcp/SKILL.md`
- `.agents/skills/verify-task/SKILL.md`
- repository and package-local `AGENTS.md` files
- active `package-backend-standard` status and implemented bundle contract

## Invariants

- Test through the browser's real `DiagramCore`; do not replace user-facing QA
  with direct mutation of internal arrays.
- MCP verification uses the live browser-backed server and confirms it sees the
  same state as the editor.
- Fix only regressions inside this initiative. Record unrelated failures with
  evidence and stop scope growth.
- Report current test counts/results; do not copy historical counts.

## Work

1. Run the smallest focused suites from T01 through T08, then the full frontend
   and MCP package gates.
2. Start the editor and MCP stack using the repository skill. Verify all bundled
   core packages are active before creating any non-Input node.
3. Install the valid external fixture directory through the visible package
   manager, add its node, connect it, and verify Lua tensor output.
4. Reload the page, confirm the package remains listed, then open a diagram that
   references its exact identity and verify on-demand activation/inference.
5. Save the diagram and inspect the downloaded JSON: every package reference
   contains ID/version and no persisted display name or local path.
6. Import a current-format fixture that still contains `name`, save it again,
   and verify canonicalization.
7. Exercise invalid directory shape, missing Python entrypoint, changed duplicate
   identity, missing/ambiguous dependency, cycle, and bundled-ID collision. Verify
   no partial installed/active state after each rejected install.
8. Exercise an installed package whose activation/Lua inference fails alongside
   an independent valid branch. Verify the fatal entry appears below Type errors,
   the valid branch still infers, and MCP returns the same diagnostic fields.
9. Verify removal is blocked for core, active, referenced, and depended-on
   packages and succeeds for an eligible external record in a fresh session.
10. Build a package bundle for the valid external graph and assert its exact
    resource closure includes the Python entrypoint and helper resource. Exercise
    the current backend submission validation if the active backend plan has
    landed; otherwise retain frontend bundle evidence without inventing a server
    fallback.
11. Run final gates, inspect the complete diff for package-ID switches, duplicate
    lifecycle owners, stale fork imports, private Cordis API use, and MCP-side
    authority.
12. Update current type-system contract and architecture overview with verified
    behavior. Mark tasks complete with real evidence and archive the plan only
    after every acceptance criterion passes.

## Acceptance criteria

- [x] All initiative acceptance criteria have current unit/integration or
      real-interface evidence.
- [x] Valid external install, immediate use, reload, exact project reopen, Lua
      inference, bundle export, and MCP inspection work end to end.
- [x] Failure cases are transactional, visible, scoped, and consistent between
      editor and MCP.
- [x] Full frontend and MCP gates pass.
- [x] Knowledge describes implemented behavior, not the earlier plan.
- [x] Plan archive contains exact commands/results and unresolved external
      blockers, if any.

## Validation

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir mcp-server test
pnpm --dir front-end test:integration:forward
git diff --check
git status --short
```

## Required handoff

Return changed files grouped by ownership, exact command results, real browser
and MCP evidence for every scenario, knowledge/archive updates, and any remaining
blocker. Do not claim completion if a required scenario was skipped.
