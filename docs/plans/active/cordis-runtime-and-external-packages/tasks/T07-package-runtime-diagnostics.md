---
id: T07
kind: task
status: ready
plan: ../plan.md
role: diagnostics
depends_on:
  - T03
  - T04
  - T06
parallel_with: []
write_scope:
  - front-end/src/type-system/diagnostics.ts
  - front-end/src/type-system/host.ts
  - front-end/src/type-system/graph/
  - front-end/src/Diagram.svelte.ts
  - front-end/src/components/Sidebar.svelte
  - front-end/src/styles/sidebar.css
  - front-end/src/__tests__/packageRuntimeDiagnostics.test.ts
  - front-end/src/__tests__/packageGraphScheduler.test.ts
---

# Surface scoped package and runtime diagnostics

## Objective

Create one structured diagnostic model for discovery, installation, activation,
inference, and disposal failures; render fatal entries below Type errors and
keep unrelated graph regions inferable.

## Context required

- [Diagnostic invariants](../plan.md#decisions-and-invariants)
- T06 activation state and project reconciliation handoff
- graph scheduler result and presentation code
- existing Sidebar Type Check panel and node `fault` presentation

## Invariants

- Diagnostics are browser-owned structured state, not reconstructed from logs.
- Stable fields are shared by editor and MCP serialization.
- Expected semantic `error`, unresolved state, and fatal host/runtime failure
  remain distinct.
- External failure scope is computed from exact package references and graph
  dependency edges. It never suppresses independent scheduling.
- Core bootstrap failure is global. The UI remains available to display it.
- Repeated graph refresh does not duplicate the same diagnostic occurrence.

## Work

1. Define `PackageRuntimeDiagnostic` with occurrence ID, severity `fatal`,
   phase (`discovery`, `install`, `validation`, `dependency`, `activation`,
   `inference`, `disposal`), message, optional package ID/version, optional node
   ID, and optional public Fiber state/context.
2. Add a bounded in-memory diagnostic collection owned by
   `EditorTypeSystemRuntime`; define replace/resolve behavior by occurrence and
   activation attempt so refresh does not append duplicates forever.
3. Convert host service, core bootstrap, external install/activation, Lua load,
   inference throw, and disposal failures into the shared model while retaining
   the original cause message.
4. Teach the scheduler to mark nodes whose exact package is unavailable or
   failed as `fault`, then propagate unresolved/fault dependency state only
   along outgoing graph dependencies. Continue scheduling independent regions.
5. Preserve the innermost package runtime cause and add node context without
   flattening it into an expected semantic error.
6. Expose runtime readiness and diagnostics from `Diagram` as reactive state.
7. Add a `Package and runtime errors` subsection immediately below the existing
   Type errors content in Sidebar. Show phase, exact identity when known,
   affected node when known, and message. Do not rely on the console.
8. Test global core failure, package-scoped activation failure, node Lua fault,
   cleanup failure, diagnostic deduplication/resolution, and a disconnected
   graph where the valid branch still succeeds.

## Acceptance criteria

- [ ] Every fatal package/runtime path visible to the editor has a structured
      diagnostic.
- [ ] Fatal diagnostics appear below Type errors with exact identity and phase.
- [ ] A failing external branch does not prevent tensor output on an independent
      core branch.
- [ ] Core bootstrap failure prevents readiness/Input spawn but remains visible.
- [ ] Refresh is deterministic and does not duplicate diagnostics.
- [ ] No error path silently becomes an expected type error.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/packageRuntimeDiagnostics.test.ts src/__tests__/packageGraphScheduler.test.ts
pnpm --dir front-end check
git diff --check
```

## Required handoff

Return the diagnostic schema, occurrence/deduplication rules, failure-scope
algorithm, screenshots or DOM assertions for panel placement, and exact test
output.

