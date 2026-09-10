---
kind: knowledge
status: current
updated: 2026-09-10
---

# Testing strategy

Verification is layered. Run the narrowest relevant test first, followed by
the package gate named in the nearest `AGENTS.md`. Never reuse historical test
counts as current evidence.

## Frontend package system

Four complementary layers cover different contracts:

1. Vitest tests package validation, Lua isolation, lifecycle, graph scheduling,
   editor state, persistence, UI behavior and browser RPC.
2. The package-only guard rejects legacy `TypeEngine`, `StereotypeCore`,
   `Stereotypes/`, nodes without exact package identity and wrapped parameters.
3. Independent candidate and pinned `stereotype-lab` processes compare the
   same versioned semantic requests and canonical results.
4. Browser QA exercises the visible editor through its real `DiagramCore` and
   verifies that UI and RPC observations agree.

Type-semantic equality belongs to cross-validation against the independent
oracle. Candidate-only tests remain authoritative for NNModelling-owned graph,
editor, persistence, transport and host behavior.

The current suite contains deterministic package-model scenarios and bounded
property-based graph comparisons. Broader realistic models, schema-aware
generation, nested composition, shrinking and a retained divergence corpus are
future work, not unfinished requirements of the completed frontend cutover.
See [`../../TODO.md`](../../TODO.md).

## Python

Pytest markers define increasing backend boundaries:

| Marker | Boundary |
| --- | --- |
| `fast` | deterministic tests without real services or training |
| `service` | real infrastructure such as Valkey |
| `e2e` | full backend jobs with real API/store/scheduler/executor |
| `legacy_e2e` | optional historical training/inference that may download MNIST |

Package-runtime and model-wheel tests additionally cover package-format
compilation. They do not replace a clean-environment installation and inference
check for the downloadable artifact.

## MCP

MCP Vitest suites cover tool schemas, thin-proxy behavior, multi-tab routing,
errors and authenticated parity with browser-owned operations. An RPC contract
change requires matching frontend handler and MCP proxy coverage.

## Linux desktop distribution

Desktop host tests cover only the platform boundary: context isolation,
sandbox and navigation policy; preload operation allowlists and validation;
directory selection; recursive reads and writes; collisions; cancellation; and
error mapping. They reuse the frontend suites for diagram, package, type,
persistence and training semantics.

An implementation handoff may use minimal installed-artifact QA when explicitly
requested: build and install the Flatpak, inspect its effective permissions,
launch to the project chooser, and retain the web production build and focused
host-adapter tests. This does not prove the complete project lifecycle.

Before public release, manual QA must additionally exercise create, edit,
automatic save, close and reopen using the installed application. A successful
Electron development launch or an uninstalled `flatpak-builder` build is
insufficient release evidence.

## Cross-boundary rule

- Package/type change: focused host or package tests plus candidate/oracle
  comparison when observable semantics change.
- Graph or persistence change: DiagramCore tests, package-only guard and
  browser save/load QA.
- RPC payload change: frontend handler and MCP tool tests.
- Remote backend lifecycle change: fast tests, then service/E2E tests in
  proportion to the boundary changed.
- Portable inference-wheel change: exporter tests plus the relevant
  download/install/import-`Model`/load/predict E2E in a clean `uv` project.
- Downloadable-model example change: install the produced wheel as a dependency
  of the standalone example, run it without the repository on `PYTHONPATH`, and
  exercise every public prediction or adapter path shown to the user.
