---
id: T01
kind: task
status: done
plan: ../plan.md
role: frontend
depends_on: []
parallel_with: []
write_scope:
  - .gitignore
  - front-end/package.json
  - front-end/pnpm-lock.yaml
  - front-end/src/__tests__/newTypeSystemLua.test.ts
  - front-end/src/__tests__/newTypeSystemInput.test.ts
  - front-end/src/type-system/
  - front-end/tests/differential/
  - stereotype-packages/core/input/
---

# Prove the input package boundary

## Objective

Infer one `core.input` node through bundled package resources, one Cordis
plugin, isolated Lua, and the frontend semantic/editor adapter, then compare
the canonical result with an independently launched oracle.

## Context required

- Read the [initiative](../plan.md) and the
  [migration decision](../../../../knowledge/decisions/stereotype-type-system-migration.md).
- In `stereotype-lab`, read `design/type-system/`, stereotype specification
  documents 01, 02, 03 and 06, `packages/core/input/`, and the TypeScript
  package/Lua runtime implementation.
- Prefer copying/adapting `src/tensor-type.ts`, `src/type-inference.ts`,
  `src/packages/{types,validation,semver,path,catalog,registry,loader}.ts`,
  `src/lua/lua-inference-runtime.ts`, and `packages/core/input/`. Start tests
  from the focused cases in `src/packages/core.test.ts`,
  `src/packages/standard-library.test.ts`, and
  `src/lua/lua-inference-runtime.test.ts`.
- Inspect current `DiagramCore` read APIs, but do not modify graph state.

## Invariants

- One package owns one Cordis fiber and one Lua state.
- Semantic `TensorType` always contains a valid shape and canonical dtype.
- Missing shape is editor `unresolved`, not a Lua error or unknown tensor.
- Expected Lua results and thrown/runtime faults use disjoint host outcomes.
- No production import or runtime call reaches `stereotype-lab`.

## Allowed files

Only the paths in `write_scope`. The editor adapter must therefore remain an
additive boundary inside `front-end/src/type-system/`; do not wire it into
`Diagram` yet.

## Out of scope

Edges, graph scheduling, UI, persistence, joins, subflows, loss, backend,
fuzzing, arbitrary discovery, and changes to the deprecated engine.

## Work

1. Copy the reference semantic/package/Lua code into the new boundary, then
   adapt only filesystem delivery, browser integration, structured fault
   separation, and the minimum public surface required by `core.input`.
2. Add a browser resource adapter and activate the copied package through a
   Cordis-owned registry/lease.
3. Adapt the isolated Wasmoon runtime and only the tensor functions required by
   `core.input`, without weakening the final sandbox contract.
4. Add a test-only versioned request/response adapter and deterministic oracle
   invocation for the same scenario.
5. Cover activation rollback and final-lease disposal.

## Acceptance criteria

- [ ] `{shape: ["B", 32], dtype: "float32"}` is byte-for-byte equal after
  canonical JSON normalization on candidate and oracle.
- [ ] Missing required shape is unresolved before Lua invocation.
- [ ] A returned expected error cannot be confused with a curated Lua fault.
- [ ] Releasing the final lease unregisters the package and destroys its state.
- [ ] The frontend production graph has no dependency on the oracle clone.
- [ ] No changes exist outside `write_scope`.

## Validation

```bash
pnpm --dir front-end test -- src/type-system tests/differential/input.test.ts
pnpm --dir front-end check
git diff --check
```

## Rollback

Revert the two dependency files and delete the three new scoped directories.
Because the slice does not alter `Diagram`, persistence, or the legacy engine,
rollback requires no data migration or compatibility code.

## Required handoff

Return files changed, commands/results, the canonical candidate/oracle payload,
proof of fault separation and disposal, any reference code/spec conflict, and
the mandatory reference-to-NNModelling reuse ledger.
