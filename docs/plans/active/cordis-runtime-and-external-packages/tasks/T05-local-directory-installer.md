---
id: T05
kind: task
status: ready
plan: ../plan.md
role: frontend-feature
depends_on:
  - T04
parallel_with: []
write_scope:
  - front-end/src/type-system/packages/install/
  - front-end/src/components/PackageManager.svelte
  - front-end/src/styles/package-manager.css
  - front-end/src/__tests__/packageInstaller.test.ts
  - front-end/src/__tests__/packageManager.test.ts
  - front-end/tests/fixtures/packages/
---

# Install external packages from a local directory

## Objective

Implement one transactional use case that reads a browser-selected package
directory, validates and resolves the complete package, persists it, and makes
the installed result available to the editor integration task.

## Context required

- [Local installation control flow](../plan.md#local-directory-installation)
- T04 catalog/store handoff
- package manifest/definition validation and semver utilities
- current browser file-input pattern in `front-end/src/utils.ts`

## Invariants

- Local directory is the only source. Do not accept URLs, archives, Git refs,
  pasted code, or server paths.
- Require one package root. All files are addressed relative to that root.
- Validate before persistence; persistence completes before activation is
  requested by the integration seam.
- An external package declares and contains definition, Lua inference, and
  Python entrypoints. Preserve every selected package-relative file as bytes.
- Every static dependency resolves to exactly one bundled/installed candidate.
  Zero or multiple candidates fail. Persist the exact chosen keys.
- A failed install leaves catalog/store state unchanged and returns one
  structured diagnostic suitable for UI and MCP reuse.

## Work

1. Define a UI-independent `installLocalPackage(files)` use case over a minimal
   `{relativePath, bytes}` input.
2. Add a browser adapter using a hidden file input with directory selection and
   multiple files. Normalize `webkitRelativePath` behind the adapter so the use
   case never depends on DOM `File` objects.
3. Detect the common root and require exactly one root `manifest.json`; reject
   empty selection, multiple package roots, duplicate normalized paths, and
   invalid relative paths.
4. Parse the manifest and definition with existing validators. Verify exact
   manifest identity/version, declared Lua/Python languages, and entrypoint
   existence before any write.
5. Resolve static dependencies against the composed catalog. Detect cycles
   across stored resolved dependencies and the candidate before persistence.
6. Canonicalize the package record, compute its digest, and persist it in one
   external-store transaction.
7. Return an explicit result distinguishing installed, already-installed, and
   rejected. Include package identity and diagnostic on rejection.
8. Add a `PackageManager.svelte` component that can open the directory picker,
   show progress/result, list bundled versus external versions, and request
   removal through callbacks. Integration into the live editor belongs to T06.
9. Add fixtures for a valid external layer with Lua, `pytorch.py`, and a helper
   resource; identical reinstall; changed duplicate; missing entrypoint;
   malformed definition; missing/ambiguous dependency; cycle; and bundled-ID
   collision.

## Acceptance criteria

- [ ] A valid directory produces one durable complete record and an activation
      request result for T06.
- [ ] `pytorch.py` and helper resources round-trip byte-for-byte.
- [ ] Invalid input performs zero durable writes.
- [ ] Same bytes reinstall idempotently; changed bytes under the same identity
      fail.
- [ ] Missing, ambiguous, incompatible, and cyclic dependencies have distinct
      actionable messages.
- [ ] PackageManager contains no graph mutation or Cordis activation logic.

## Validation

```bash
pnpm --dir front-end test -- --run src/__tests__/packageInstaller.test.ts src/__tests__/packageManager.test.ts
pnpm --dir front-end check
git diff --check
```

## Required handoff

Return the normalized file-input contract, validation order, install result
shape, fixture identities, exact test output, and the callback interface T06
must connect.

