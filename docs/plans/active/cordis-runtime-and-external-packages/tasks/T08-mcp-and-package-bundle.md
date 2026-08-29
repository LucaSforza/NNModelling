---
id: T08
kind: task
status: ready
plan: ../plan.md
role: transport
depends_on:
  - T06
  - T07
parallel_with: []
write_scope:
  - front-end/src/sync/BrowserRPCHandler.ts
  - front-end/src/training/package-bundle.ts
  - front-end/src/type-system/packages/types.ts
  - front-end/src/__tests__/BrowserRPCHandler.test.ts
  - front-end/src/__tests__/packageBundle.test.ts
  - mcp-server/src/tools/inspection.ts
  - mcp-server/src/__tests__/
---

# Expose diagnostics through MCP and external resources through bundles

## Objective

Keep the browser as package authority while exposing the same package/runtime
diagnostics through MCP and feeding complete exact external resources into the
existing package-bundle submission seam.

## Context required

- T06 exact runtime/catalog handoff
- T07 structured diagnostic schema
- `front-end/src/sync/BrowserRPCHandler.ts`
- `mcp-server/src/tools/inspection.ts`
- `front-end/src/training/package-bundle.ts`
- active `package-backend-standard` P02/P06 contracts

## Invariants

- MCP remains a thin RPC proxy. It does not open IndexedDB, read local package
  directories, activate packages, or cache diagnostics.
- Browser RPC and visible editor serialize the same diagnostic objects.
- Bundle selection uses exact graph identities and exact resolved dependency
  keys; no display-name or ID-only fallback.
- Export package bytes from the composed installed record. Do not special-case
  external paths or execute Python during export.
- Reuse `package-bundle/v1` and the current backend submission seam unless the
  active backend plan has already changed them. Coordinate rather than fork.

## Work

1. Extend browser serialization so `get_graph` and `get_type_info` include
   runtime readiness and package diagnostics.
2. Add browser RPC `get_package_diagnostics` and a thin MCP inspection tool of
   the same name for explicit fatal-error inspection.
3. Extend `list_stereotypes` or add a narrowly named package-list response that
   distinguishes bundled/external and installed/active/failed without exposing
   raw package bytes.
4. Update BrowserRPC dispatch if needed so package-aware diagram import awaits
   reconciliation and returns the resulting diagnostics deterministically.
5. Generalize `PackageExportInfo` to read the full immutable resource map from
   bundled or external records; avoid a copied external-only export structure.
6. Build the exact transitive resolved dependency closure. Reject missing,
   inactive, wrong-version, ambiguous, or failed packages before submission.
7. Include every required package-relative file in deterministic path order,
   including the declared Python entrypoint and helper files. Preserve current
   canonical digest behavior.
8. Add frontend tests for external resource closure, byte content/digest,
   dependency versions, and submission failure. Add MCP proxy/serialization
   tests proving field parity and no server-side state.
9. Check the current `package-backend-standard` implementation before editing
   shared bundle assumptions. If P02/P06 has materially changed the seam, adapt
   this task to that implemented contract and document the coordination.

## Acceptance criteria

- [ ] Editor and MCP return equal diagnostic records for the same live browser
      state.
- [ ] MCP can explicitly retrieve fatal package/runtime diagnostics.
- [ ] MCP server code contains no package registry/store/runtime implementation.
- [ ] A bundle for an external node contains exact identity, resolved dependency
      closure, `pytorch.py`, and helper resources.
- [ ] Missing or failed exact packages prevent submission with a diagnostic
      that identifies the package.
- [ ] Existing bundled-only bundle fixtures remain valid.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/BrowserRPCHandler.test.ts src/__tests__/packageBundle.test.ts
pnpm --dir mcp-server test
pnpm --dir front-end check
git diff --check
```

## Required handoff

Return the RPC/MCP response additions, proof the server remains stateless, one
external bundle manifest example without raw source in the report, backend-plan
coordination notes, and exact test output.

