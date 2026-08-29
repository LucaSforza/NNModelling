---
id: T04
kind: task
status: ready
plan: ../plan.md
role: storage
depends_on:
  - T02
parallel_with:
  - T03
write_scope:
  - front-end/src/type-system/packages/catalog.ts
  - front-end/src/type-system/packages/types.ts
  - front-end/src/type-system/packages/installed/
  - front-end/src/type-system/bundled/catalog.ts
  - front-end/src/__tests__/installedPackageCatalog.test.ts
---

# Build the installed package catalog

## Objective

Represent bundled and external packages through one immutable catalog contract
and persist validated external package records in IndexedDB without changing
runtime activation yet.

## Context required

- [Installed package record contract](../plan.md#installed-package-record)
- `front-end/src/type-system/packages/{catalog.ts,types.ts,validation.ts}`
- `front-end/src/type-system/bundled/catalog.ts`
- `front-end/src/training/package-bundle.ts`

## Invariants

- Catalog key is exact `id@version`; display name never resolves identity.
- Bundled and external sources use the same read-only resource-provider seam.
- External bytes are stored exactly once with an internal digest. No local path
  or browser directory handle is persisted.
- Bundled records are immutable and cannot be shadowed by external records.
- Storage implementation and catalog domain API are separated so unit tests can
  use an in-memory store.
- IndexedDB schema starts at `nnmodelling-packages/v1` and upgrades are explicit.

## Work

1. Introduce `PackageKey`, source, installed-record, resource-map, digest, and
   resolved-dependency types without leaking IndexedDB types into callers.
2. Generalize `PackageCatalog` from one package per ID to exact `id@version`
   lookup plus explicit queries by ID/range.
3. Adapt bundled discovery to emit immutable installed records containing the
   complete package-relative resource map.
4. Define a narrow asynchronous external-store interface: list/get/put/delete
   complete records in one transaction.
5. Implement the browser IndexedDB adapter and an in-memory test adapter.
6. Compose bundled records and stored external records deterministically. Reject
   any external record whose ID collides with a bundled package ID.
7. Make identical `id@version` plus digest idempotent and changed bytes a typed
   conflict. Store resolved dependency keys with the record.
8. Expose complete resource bytes to later inference and bundle adapters without
   adding a second export cache.
9. Test reload, exact version lookup, multiple external versions, bundled
   collision, byte preservation, idempotent put, changed-content rejection,
   transactional delete, and schema-open failure.

## Acceptance criteria

- [ ] A fresh catalog contains every bundled package as an immutable record.
- [ ] External records survive closing and reopening the store contract.
- [ ] Two versions of a non-core external ID may coexist and require exact
      lookup.
- [ ] Bundled IDs cannot be shadowed or deleted.
- [ ] Full resource bytes round-trip without newline or encoding corruption.
- [ ] No activation, UI, DiagramCore, or MCP code is changed in this task.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/installedPackageCatalog.test.ts
pnpm --dir front-end check
git diff --check
```

## Required handoff

Return the catalog/store interfaces, IndexedDB schema and transaction boundary,
the bundled-composition rule, exact test output, and any coordination needed
before T03 and T04 are integrated.

