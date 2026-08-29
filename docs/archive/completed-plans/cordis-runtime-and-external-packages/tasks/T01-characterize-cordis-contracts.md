---
id: T01
kind: task
status: complete
plan: ../plan.md
role: migration-test
depends_on: []
parallel_with: []
write_scope:
  - front-end/src/__tests__/cordisMigration.test.ts
  - front-end/src/__tests__/packageLifecycle.test.ts

evidence:
  initial_validation: |
    Command: pnpm --dir front-end test -- --run src/__tests__/cordisMigration.test.ts src/__tests__/packageLifecycle.test.ts
    The requested files did not exist, so Vitest ran the existing suite:
    Test Files 18 passed (18); Tests 132 passed (132); exit 0.
  focused_validation: |
    Command: pnpm --dir front-end exec vitest run src/__tests__/cordisMigration.test.ts src/__tests__/packageLifecycle.test.ts
    Test Files 2 passed (2); Tests 7 passed (7); exit 0.
  full_suite: |
    Command: pnpm --dir front-end test
    Test Files 20 passed (20); Tests 139 passed (139); exit 0.
  package_gate: |
    Command: pnpm --dir front-end check
    svelte-check found 0 errors and 9 warnings in 4 files; exit 0.
  diff_check: |
    Command: git diff --check
    exit 0.
  lifecycle_matrix: |
    dependency activation: test.lifecycle-dependency before test.lifecycle-app; disposal is reverse order.
    shared leases: one rule load; first release retains registration; final release unregisters and disposes once.
    idempotence: repeated lease disposal and repeated host disposal have no additional effect.
    activation rollback: missing dependency, incompatible version, static cycle, Lua load failure, and duplicate active ID leave no leaked registry entry; a dependency loaded before a parent load failure is disposed once.
    diagnostics: semantic kind mismatch is status=error; thrown inference is status=fault with packageId and phase=inference.
    host disposal: every package activated by the host is inactive and absent from activePackages() after disposal.
  observable_limits: |
    Cleanup is observed through the public PackageLoader, PackageRegistry, Context Fiber,
    and TypeSystemHost APIs; no private Cordis Fiber/event fields are inspected.
    The requested task command's extra '--' causes Vitest to run all tests; the direct
    vitest command above is the exact two-file gate. Upstream timing differences were
    not observable because the current implementation uses synchronous registry effects;
    ownership and exact cleanup counts are asserted.
---

# Characterize the Cordis and package lifecycle contracts

## Objective

Create a dependency-independent regression gate that captures observable
package lifecycle behavior before replacing DeepSeek Cordis. This task changes
tests only and must pass against the current implementation.

## Context required

- [Initiative plan](../plan.md)
- `front-end/src/type-system/host.ts`
- `front-end/src/type-system/packages/loader.ts`
- `front-end/src/type-system/packages/registry.ts`
- `front-end/src/type-system/packages/lua-runtime.ts`
- existing package host, Lua runtime, and differential oracle tests

## Invariants

- Test public NNModelling behavior and public Cordis behavior; never assert
  private Cordis fields.
- Do not change production code, dependencies, manifests, or lockfiles.
- Use synthetic packages with unique IDs. Do not make tests depend on core
  package names except where core bootstrap is the behavior under test.
- Each cleanup observation must have an unambiguous owner and call count.

## Work

1. Add fixtures for a package with a static dependency and a disposable loaded
   Lua rule.
2. Characterize successful dependency-first activation and reverse-order
   disposal.
3. Prove two leases share one active rule/Fiber and only the final release
   unregisters and disposes it.
4. Prove double lease disposal and double host disposal are idempotent.
5. Prove a missing dependency, incompatible version, static cycle, duplicate
   active ID, and thrown Lua load fail activation without leaked registry
   entries or dependency leases.
6. Prove an inference exception remains a `fault`, while expected semantic
   incompatibility remains an `error`.
7. Prove host disposal clears every package rule and registration acquired by
   the host.
8. Record the precise expectations that require adjustment if upstream Cordis
   exposes different public timing but the same ownership semantics; do not
   weaken call-count or leak assertions.

## Acceptance criteria

- [ ] New tests pass against `@deepseek-ai/cordis@4.0.1` before migration.
- [ ] Activation failure leaves no observable active package.
- [ ] Rule and dependency cleanup are each observed exactly once.
- [ ] Semantic errors and host faults remain distinguishable.
- [ ] No production file changed.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/cordisMigration.test.ts src/__tests__/packageLifecycle.test.ts
git diff --check
```

## Required handoff

Return the tested lifecycle matrix, exact command output, and any behavior that
could not be observed without relying on private Cordis internals.
