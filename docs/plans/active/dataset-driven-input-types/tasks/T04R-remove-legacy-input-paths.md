---
id: T04R
kind: task
status: ready
plan: ../plan.md
role: integration
depends_on: [T04]
parallel_with: []
write_scope:
  - front-end/
  - converted/
  - mcp-server/
  - stereotype-packages/
  - examples/
  - docs2/
---

# Remove legacy Input typing and dataset-adapter paths

## Objective

Delete the superseded Input `shape`/`dtype` authority, dataset-owned inference
adapter path and compatibility tests after supported diagrams and datasets have
been migrated.

## Context required

- [Initiative](../plan.md) and T01–T04 handoffs
- [Dataset-driven Input decision](../../../../knowledge/decisions/dataset-driven-input-types.md)
- Active frontend, MCP, backend, package, example and public-documentation
  references to Input parameters and dataset inference adapters

## Invariants

- Migration must land before deletion; supported user data is migrated once and
  saved in the new representation.
- There is no permanent feature flag, precedence rule or hidden fallback.
- Model/package wheel adapters are the only portable inference adapter owner.
- Historical documentation under `docs/archive/` is evidence and need not be
  rewritten as current behavior.
- Unrelated legacy systems are outside this focused removal.

## Allowed files

Only active implementation, fixtures, tests, examples and public documentation
under `write_scope`. Current KB and the initiative plan are read-only; report
any contradiction to the coordinator.

## Out of scope

- New Input behavior, unrelated compatibility cleanup or real VAE training.
- Deleting migration code before it has converted every supported source form.

## Work

1. Search every active consumer, serializer, test and document for Input
   `shape`/`dtype` parameters, dataset `inferenceAdapter`, compatibility flags,
   fallback branches and obsolete diagnostics.
2. Classify each occurrence as new contract, one-way migration, obsolete active
   path or historical archive evidence.
3. Delete obsolete active paths and rewrite tests that assert retired behavior;
   do not preserve them behind flags.
4. Prove new diagrams cannot save legacy Input parameters and new datasets
   cannot define portable dataset-owned adapters.
5. Run focused removal searches and all affected package gates.

## Acceptance criteria

- [ ] No reachable active code reads Input `params.shape` or `params.dtype` as
      a top-level model input type.
- [ ] No reachable active code packages or executes dataset `inferenceAdapter`.
- [ ] Supported old sources migrate once; new saves contain only the new form.
- [ ] Tests assert rejection or migration, never permanent fallback semantics.
- [ ] Current public documentation describes only the new contract.
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

The handoff must also include focused search results demonstrating that any
remaining legacy terms are confined to one-way migration code or historical
archives.

## Required handoff

Return the classified occurrence inventory, deleted paths, migration paths
retained, files changed, exact commands/results and any stale contract that T05
must reconcile.
