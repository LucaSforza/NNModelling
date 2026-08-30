---
id: T07
kind: task
status: blocked
plan: ../plan.md
role: integration
depends_on: [T06, T08]
parallel_with: []
write_scope:
  - mcp-server/__tests__/
  - front-end/src/__tests__/
  - docs/plans/active/mcp-use-case-parity/
  - docs/knowledge/architecture/browser-mcp.md
  - docs/knowledge/uml/mcp-use-case-parity.md
  - docs/knowledge/testing/strategy.md
---

# Verify UML parity through the real interfaces

## Objective

Prove the accepted UML workflows and preserved capabilities end to end, then align the KB with implemented behavior.

## Context required

Read the [initiative plan](../plan.md), its source links and the
[accepted UML](../../../../knowledge/uml/mcp-use-case-parity.md).

Read the accepted UML, all preceding handoffs, local AGENTS verification rules, verify-task and the repository browser workflow skill.

## Invariants

Do not mark a mock as live proof. Use disposable projects and explicitly authorized backend jobs. Do not modify unrelated user diagrams, approve pairing as admin or provision infrastructure.

## Allowed files

- `mcp-server/__tests__/`
- `front-end/src/__tests__/`
- `docs/plans/active/mcp-use-case-parity/`
- `docs/knowledge/architecture/browser-mcp.md`
- `docs/knowledge/uml/mcp-use-case-parity.md`
- `docs/knowledge/testing/strategy.md`

Directory scopes permit only changes serving this task. Narrow them to the
actual files in the handoff; do not reorganize unrelated modules.

## Out of scope

No opportunistic product changes or generic code-review pass. Failures go back to their owning task; no automatic expansion into backend/dataset infrastructure.

## Work

1. Record the current tools/list catalog and exercise representative public tools/call payloads over the actual transport. Add regression coverage for retained operations and actionable invalid-input failures.
   First exercise M6 from the startup chooser: create with UI-equivalent fields,
   edit and autosave, then reopen through MCP. Compare manifest/resource scope
   with UI opening; test cancellation, permission denial, invalid project and
   collision without overwriting files. Verify every UML oval has an actor association.
2. Exercise M1–M3 in a writable disposable project: compare Sidebar/MCP node defaults, false/zero values, shape/list/reference parameters, adapters and output; check connection rejection, join order, undo/redo and reopen/autosave.
3. Exercise M4–M5 with two distinguishable tabs and both directions. Inspect the actual browser images after layout, verify correct target and compare with Disponi.
4. Exercise T1–T2: pairing pending/approval, all current sidebar fields, UI-to-MCP and MCP-to-UI updates, closed-sidebar behavior, session expiry and safe ownership errors.
5. Exercise T3–T5 using an explicitly authorized tiny model: complete bundle upload/submission, observe progress before completion, download the actual wheel and verify digest. Cover a model-custom package closure without implementing new authoring.
6. Install the downloaded wheel in a clean temporary uv consumer project using the declared nnm_<suffix> module. Import Model and run the fixture's documented public predict/predict_tensor call without repository PYTHONPATH, backend state or training dataset.
7. Record exact commands, fixture/configuration, outcomes and limitations in evidence/parity.md. Update architecture only for observed implemented behavior; mark tasks done/archive only after all acceptance gates pass.

## Acceptance criteria

- [ ] Evidence maps all eleven UML IDs to concrete public-interface observations, including project creation/opening before editor mount.
- [ ] Retained tools, project scope, graph history and backend ownership have regression evidence.
- [ ] Wheel download/install/Model prediction is proven outside the repository environment.
- [ ] Missing capture support, compute, approval or integration checks remain explicit incomplete gates.
- [ ] No changes outside the declared write scope.

## Validation

Run from the repository root. Extend the listed tests for the new behavior;
passing unchanged proxy mocks alone is not proof of this task.

```bash
pnpm --dir mcp-server test
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end guard:package-only
pnpm --dir front-end build
git diff --check
```

The live steps above supplement these commands. Record the exact uv install and fixture-specific prediction commands once the produced wheel name/path are known; do not present placeholders as executed checks. Backend changes are outside this task and require a separate approved scope with its fast/service/E2E gates.

## Required handoff

Return changed files, exact checks/results, observed user-facing behavior,
resolved assumptions, remaining blockers and affected KB statements. Keep
credentials out of evidence. Update this task's status in its own file; the
initiative plan owns overall status.

## Handoff status

Parity verification is blocked on external integration gates, not on a
manufactured test result. The public stdio server and in-app Browser were
exercised. The browser remained at the startup chooser, so no DiagramCore was
mounted; M1–M3 and T1–T3 cannot be claimed. The catalog has no `format_view`
operation, and screenshot capture still requires a selected-tab binding and
available DevTools; M4–M5 cannot be claimed. No authorized backend job or
wheel was available, so T4–T5 and clean-consumer Model prediction cannot be
claimed.

Detailed commands, transport observations, all eleven UML mappings and exact
blockers are recorded in [`../evidence/parity.md`](../evidence/parity.md).

The startup-project dependency is now explicitly T08: the parent workflow has
reopened T08 to implement MCP-owned create/open with an explicit `projectPath`.
T07 must be rerun after that handoff and must not be marked complete from the
current startup-chooser observation.
