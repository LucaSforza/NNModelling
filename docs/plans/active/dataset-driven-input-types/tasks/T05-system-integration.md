---
id: T05
kind: task
status: ready
plan: ../plan.md
role: integration
depends_on: [T04R]
parallel_with: []
write_scope:
  - front-end/
  - converted/
  - mcp-server/
  - stereotype-packages/
  - examples/
  - docs2/
---

# Audit and complete cross-system integration

## Objective

Read the complete affected implementation and test paths, then add only the
missing glue or corrections needed for one coherent dataset-driven Input system.

## Context required

- [Initiative](../plan.md) and every T01–T04R handoff
- Current frontend, bundle, backend, worker, wheel, MCP and example implementations
- Applicable package-local guidance and verification skills

## Invariants

- This is an integration task, not a redesign opportunity.
- There is one Input type authority and one adapter ownership path.
- Browser, MCP, backend and wheel expose the same binding/type semantics.
- Unrelated user changes and behavior remain untouched.

## Allowed files

Affected implementation, tests, examples and public documentation under the
listed roots. Current KB and this plan are read-only to this task; report any
inaccuracy to the coordinator.

## Out of scope

- New features beyond the accepted decision.
- Real VAE training or claiming final acceptance without T06.

## Work

1. Read all implementations changed by T01–T04R plus every consumer of Input
   parameters, dataset slot shapes, graph bindings, adapter metadata, bundle
   schemas, checkpoints and wheel input contracts.
2. Trace create/open/edit/save, dataset selection, type inference, browser RPC,
   MCP, submission, worker, training, export and public inference end to end.
3. Search for and remove missing seams, stale assumptions and duplicate sources;
   route large subsystem defects back to their owning task.
4. Add focused cross-package regression tests for issues found during the audit.
5. Run all package gates and confirm the migrated VAE is ready for isolated QA.

## Acceptance criteria

- [ ] Every affected implementation path has been inspected and recorded in the handoff.
- [ ] Browser/MCP/training/wheel contracts agree on bindings, types and adapters.
- [ ] No active legacy Input shape/dtype fallback or dataset inference adapter remains.
- [ ] Full relevant frontend, MCP and Python gates pass.
- [ ] VAE prerequisites for T06 are explicitly confirmed.
- [ ] No changes outside `write_scope`.

## Validation

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir mcp-server test
cd converted && uv run pytest src/tests/ -m fast -q
uv run --project examples/vae_mnist pytest -q
git diff --check
```

## Required handoff

Return the inspected path inventory, missing seams found and fixed, files
changed, exact commands/results, remaining risks and an explicit T06 readiness
decision.
