---
id: T12
kind: task
status: completed
plan: ../plan.md
role: frontend-testing
depends_on: [T11]
parallel_with: []
---

# Delete the deprecated type system and lock the boundary

## Objective

Physically remove the deprecated frontend type system, legacy stereotype data,
and tests that asserted its semantics. Prove the remaining frontend solely by
the package engine and the independent `stereotype-lab` oracle.

## Scope

- Delete `front-end/src/conversion/typeEngine.ts`, `StereotypeCore`, and
  unreferenced legacy tensor/diagnostic/expression implementation.
- Delete repository `Stereotypes/` and every production import or loader that
  consumes it.
- Delete unit/integration tests whose subject is the old engine, its formulas,
  wrappers, suggestions, or legacy stereotype JSON. Do not preserve them as a
  compatibility suite.
- Delete or archive documents that describe the removed engine as current.
- Add a CI/static guard that fails on production imports/references to
  `TypeEngine`, `StereotypeCore`, or `Stereotypes/`; checked-in frontend nodes
  without `data.package`; and wrapped package parameter values.
- Run the pinned oracle and candidate through separate processes. Type-semantic
  acceptance requires canonical equality; local unit tests cover only host,
  editor, persistence, topology, and transport invariants.
- Preserve and run graph differential fuzzing, shrinking, and retained
  regression cases as the frontend completion gate. If the existing fuzzing
  implementation is incomplete, complete it here rather than claiming the
  frontend migration is finished.

## Reference-first rule

Before changing semantic code, inspect and preferentially copy/adapt the pinned
reference sources named in the initiative plan. Record a reuse ledger. The
oracle remains test-only and must not enter the production bundle. Normative
`design/` wins over executable reference conflicts.

## Required evidence

- Repository guard proves the forbidden legacy symbols/files/formats are gone.
- Pinned reference suite passes independently.
- Candidate/oracle deterministic scenarios pass for every applicable copied
  reference vector and the checked-in Transformer, VAE, and ResNet graphs.
- Differential fuzzing covers valid complete DAGs, targeted invalid mutations,
  ordered joins, dtypes, nested subflows, dynamic references, expected errors,
  and structured context; divergences shrink and persist as regressions.
- `pnpm --dir front-end check`, full frontend tests, production build, and live
  browser QA pass without the legacy directory.

## Excluded

- Backend implementation. Future agents must begin from
  `stereotype-lab/design/stereotype-specification/04-pytorch-runtime.md`,
  `06-loading-and-lifecycle.md`, `design/type-system/03-dtype-system.md`,
  `design/nnmodelling-integration/README.md`, `python/stereotype_runtime/`, and
  `packages/core/*/pytorch.py`.

## Rollback

Revert T12 as one commit. Do not partially restore legacy files: rollback must
restore the coherent T11 boundary, while compilation remains unavailable.

## QA evidence

- The package-only guard covers both frontend and MCP production sources.
- The MCP bootstrap no longer loads a server-side `Stereotypes/` cache;
  `list_stereotypes` delegates to the browser-owned package catalog.
- The live editor distinguishes incomplete state, semantic type errors, and
  runtime faults. With no selected node, the Type Check panel still renders
  every diagnostic row instead of showing only a non-zero count.
