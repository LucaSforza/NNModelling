---
id: T11
kind: task
status: completed
plan: ../plan.md
role: frontend
depends_on: [T10]
parallel_with: []
---

# Cut Browser RPC and persisted fixtures over to packages

## Objective

Give browser automation and persisted frontend artifacts exactly the same
package-only contract as the visible editor.

## Scope

- Migrate `BrowserRPCHandler` parameter operations to primitive values and the
  active package schema.
- Make `get_type_info` return the sole new-engine result, then remove the
  duplicate `get_package_type_info` endpoint.
- Derive graph statistics and validation from package `kind`, never package ID
  or legacy stereotype categories. Whole-graph completeness means exactly one
  terminal; `input`, `loss`, `join`, and `subflow` topology is kind-driven.
- Report compilation/conversion/training/inference as unavailable for package
  graphs until the backend package runtime exists. Do not invoke the legacy
  compiler and do not use PyTorch to determine types.
- Replace frontend examples, editable fixtures, tests, and applicable manifest
  entries with package-format artifacts. Breaking legacy format is intended;
  do not add a converter.
- Keep the MCP server a thin proxy over the browser's `DiagramCore`.

## Required evidence

- Browser RPC tests exercise create, parameter update/reset/query, type query,
  statistics, validation, save/load, and the explicit compilation boundary.
- Every checked-in editable frontend diagram has package identity on every node
  and no wrapped parameter.
- Real browser/MCP QA loads the Transformer, VAE, and ResNet package fixtures,
  selects nodes, queries type information, and verifies visible and RPC results
  agree.
- Candidate/oracle deterministic model cross-validation remains green.

## Excluded

- Backend or `pytorch.py` loading, a compatibility endpoint, and automatic
  migration of old user projects.

## Rollback

Revert T11 as one commit; T10 remains a package-only local editor contract.
