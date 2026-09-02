---
id: T06
kind: task
status: ready
plan: ../plan.md
role: verification
depends_on: [T05]
parallel_with: []
write_scope:
  - front-end/tests/
  - docs/plans/active/project-workspaces-and-stereotype-authoring/
---

# Verify the phase-one workspace and stereotype slice

## Objective

Exercise New/Open, automatic saving, model title, parameter authoring, generated
identity behavior, reopening, palette scope, package bundle and MCP parity
through the real browser-owned editor. This is the mandatory QA gate before
dataset implementation; it does not close or archive the initiative.

## Context required

- [Plan](../plan.md)
- `.agents/skills/nnmodelling-mcp/SKILL.md`
- `.agents/skills/verify-task/SKILL.md`
- Existing browser fixtures and model-scoped T05 evidence

## Invariants

- Use the visible editor and actual browser filesystem capability; unit-level
  mutation is not sufficient evidence.
- Browser DiagramCore remains the only graph authority and MCP remains a thin
  proxy.
- Test data is confined to an explicitly created temporary project parent.
- Dataset UI and standard dataset behavior are observed only for regression.
- T07 and every phase-two task remain blocked until this task passes.

## Allowed files

- The files and directories in `write_scope` only.

## Out of scope

- Feature implementation beyond fixes required to satisfy phase one, local
  dataset implementation, broad knowledge cleanup, archival and release work.

## Work

1. Add or update a browser flow that creates a project through the visible
   parent-directory picker and model form.
2. Verify Input bootstrap, model title, ordered automatic saving and reopening
   from the resulting directory.
3. Create an identity layer with representative parameter variants, inspect
   its four files and manifest entry, add it to the graph and verify Lua tensor
   preservation.
4. Verify package palette scope, diagnostics, resolved bundle resources and MCP
   inspection against the same browser state.
5. Exercise unsupported/denied capability, existing child, invalid authoring,
   write failure where injectable at the real boundary, and recovery.
6. Run the phase-one gates, retain concise evidence, mark T01-T06 complete and
   explicitly unlock T07. Do not mark the plan complete or archive it.

## Acceptance criteria

- [ ] The real UI proves every plan acceptance criterion relevant to browser
      behavior.
- [ ] Generated files and reopened state match the accepted project contract.
- [ ] MCP and package bundle match the visible active model scope.
- [ ] Dataset behavior is unchanged.
- [ ] T07 is unlocked only after every phase-one criterion passes.
- [ ] No changes outside `write_scope`.

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

Report the real user journeys, generated filesystem evidence, model/package/MCP
observations, exact commands and results, retained evidence, defects and the
explicit pass/fail decision for the phase-two gate.
