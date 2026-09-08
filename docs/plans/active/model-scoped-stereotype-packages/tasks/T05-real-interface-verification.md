---
id: T05
kind: task
status: ready
plan: ../plan.md
role: verification
depends_on: [T02, T03, T04]
parallel_with: []
write_scope:
  - front-end/tests/
  - docs/plans/active/model-scoped-stereotype-packages/
---

# Verify model switching through the user-facing interfaces

## Objective

Exercise model loading, switching, package palette state, diagnostics, MCP
parity, and bundle-visible behavior through the real editor flow.

## Invariants

- Use the browser's `DiagramCore` through the visible editor; do not prove the
  feature only by mutating internal arrays.
- MCP remains a thin view of browser-owned state.
- A failed switch leaves the prior model usable.
- Verification distinguishes pre-existing graph/type errors from package-scope
  regressions.

## Work

1. Open the core-only ResNet model and verify no model custom packages appear.
2. Open the VAE model and verify Sampling and KL divergence are available and
   infer correctly.
3. Switch VAE→ResNet and verify all VAE package definitions, rules, palette
   entries, and diagnostics disappear.
4. Switch ResNet→VAE and verify exactly the VAE package set is restored.
5. Attempt a model with a missing or invalid local package and verify the old
   model remains active.
6. Inspect the same package catalog and graph through browser-backed MCP.
7. Run final frontend, MCP, backend, and diff checks; retain only useful
   evidence with the plan.

## Acceptance criteria

- [ ] All switching and failure scenarios pass through the real editor.
- [ ] MCP reports the same active model package scope as the browser.
- [ ] Final gates and `git diff --check` pass.

## Validation

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir mcp-server test
cd converted && uv run pytest src/tests/test_package_runtime.py -q
git diff --check
```

## Required handoff

Return real-interface scenarios, exact commands/results, changed knowledge
documents, retained evidence, and unresolved risks. Do not claim completion if
the browser/MCP switch was skipped.
