---
id: T11
kind: task
status: blocked
plan: ../plan.md
role: backend-security
depends_on: [T07, T09]
parallel_with: []
write_scope:
  - converted/src/backend/
  - converted/src/tests/
  - front-end/src/training/dataset-bundle.ts
  - front-end/src/__tests__/
---

# Upload and resolve project dataset archives safely

## Objective

Implement the deliberately simple v1 transport: one bounded authenticated
archive per digest, immutable owned storage and a read-only worker mount behind
an opaque reference.

## Invariants

- FastAPI never imports or executes uploaded Python.
- Archive paths are confined; absolute paths, traversal, symlinks and special
  files are rejected before persistence.
- Digest, dataset ID/version and authenticated owner are inseparable.
- No host/browser path enters a job contract; no resumable/large-data behavior
  is implied.

## Work

1. Build deterministic browser archive/digest creation and progress reporting.
2. Add backend-advertised maximum size and enforce it while receiving data.
3. Validate metadata/closure, store by owned digest and return an opaque ref.
4. Resolve and mount the immutable archive read-only in the worker container.
5. Test deduplication, ownership isolation, corruption, archive attacks, limit
   failures and proof that FastAPI never imports the entrypoint.

## Acceptance criteria

- [ ] Over-limit uploads fail before durable publication and expose the limit.
- [ ] Identical owned digests deduplicate; cross-owner references are denied.
- [ ] Only the worker receives the read-only resolved resources.
- [ ] Failed upload creates neither a valid reference nor a training job.

## Required handoff

Report the size/digest/ownership model, mount boundary, threat tests and limits
explicitly deferred to a later large-dataset design.
