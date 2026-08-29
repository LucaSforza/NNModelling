---
id: T03
kind: task
status: ready
plan: ../plan.md
role: runtime
depends_on:
  - T02
parallel_with:
  - T04
write_scope:
  - front-end/src/type-system/host.ts
  - front-end/src/type-system/packages/loader.ts
  - front-end/src/type-system/packages/registry.ts
  - front-end/src/type-system/packages/lua-runtime.ts
  - front-end/src/type-system/packages/cordis-services.ts
  - front-end/src/__tests__/cordisMigration.test.ts
  - front-end/src/__tests__/packageLifecycle.test.ts
---

# Make Cordis services and Fibers own the package runtime

## Objective

Mount the package registry and Lua runtime as typed Cordis services, then make
one package Fiber the only cleanup owner for each active package while
preserving all characterized semantics.

## Context required

- [Accepted runtime decision](../../../../knowledge/decisions/local-package-runtime.md)
- T02 dependency-only migration and test output
- upstream Cordis public `Context`, `Service`, plugin, effect, and Fiber APIs
- `front-end/src/type-system/{host.ts,packages/loader.ts}`

## Invariants

- One active `id@version` equals one package Fiber.
- Service providers mount before package activation and outlive package Fibers.
- Missing services fail activation immediately. Do not use `inject` for this
  contract and do not accept a `PENDING` Fiber as success.
- Domain state may track active identities and leases, but it must not become a
  second resource-disposal stack.
- Each acquired dependency lease, registry entry, and loaded Lua rule has one
  Fiber effect disposer.
- Effects unwind in reverse acquisition order and remain idempotent.
- Use public Cordis APIs only. No private Fiber/event inspection.

## Work

1. Add `PackageRegistryService` and `LuaInferenceService` using upstream Cordis
   service conventions and TypeScript declaration merging for `Context`.
2. Mount both services during `TypeSystemHost` construction and assert their
   availability before any package activation.
3. Change `PackageLoader` to obtain services from its Cordis context instead of
   constructor-injected private objects.
4. Create the package plugin/Fiber before acquiring package-owned resources.
   Within its apply path, acquire dependencies, load the Lua rule, register the
   active package, and immediately attach each disposer as an effect.
5. Retain an active identity/lease record only for domain lookup and shared
   activation. Remove manual rollback/disposal paths now owned by the Fiber.
6. Ensure partial apply failures dispose the Fiber and unwind already attached
   effects. Attach a cleanup effect immediately after each successful acquire.
7. Dispose all package Fibers before service/root-context disposal.
8. Extend T01 tests with service absence, partial acquisition, multiple active
   packages, and reverse cleanup order.
9. Add a structural test or narrow assertion proving one package activation
   creates one Fiber and one registry registration without depending on Cordis
   private fields.

## Acceptance criteria

- [ ] Host code reaches registry and Lua functionality through typed Cordis
      services.
- [ ] Removing either required service produces a fatal activation failure,
      never a pending package.
- [ ] Every resource disposer has one Fiber effect owner.
- [ ] No catch block duplicates cleanup already owned by the package Fiber.
- [ ] T01 lifecycle semantics and differential inference remain unchanged.
- [ ] No Cordis event, waterfall, loader/HMR, or dependency `inject` code exists.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/cordisMigration.test.ts src/__tests__/packageLifecycle.test.ts
pnpm --dir front-end test -- --run src/__tests__/packageTypeSystem.test.ts
pnpm --dir front-end check
git diff --check
```

Adjust the second filename to the existing focused host/inference suite if
different, and report the actual command.

## Required handoff

Return a resource-ownership table mapping every acquire operation to its Fiber
effect, the removed duplicate cleanup paths, exact test output, and any public
Cordis API limitation encountered.

