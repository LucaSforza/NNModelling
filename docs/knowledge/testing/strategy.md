---
kind: knowledge
status: current
updated: 2026-08-12
---

# Testing strategy

Verification is layered so agents can start narrowly and expand only when a
change crosses a boundary. Never copy historical test counts into current
status; run the applicable command.

## Frontend

- Vitest unit tests cover pure TypeScript, Svelte-compiled state, type inference,
  graph mutations and browser RPC.
- `pnpm --dir front-end check` is the Svelte/TypeScript gate.
- Integration tiers are `smoke`, `convert`, `forward`, `train` and `infer`.
  Tiers beyond smoke invoke real Python and accept selectors such as
  `NNM_DIAGRAM` and `NNM_DEVICE`.
- `examples/manifest.json` defines cross-language fixture metadata.

## Python

Pytest markers define increasing boundaries:

| Marker | Boundary |
| --- | --- |
| `fast` | deterministic tests without real services or training |
| `service` | real infrastructure such as Valkey |
| `e2e` | full canonical backend jobs with real API/store/scheduler/executor |
| `legacy_e2e` | optional training/inference that may download MNIST |

The default pytest configuration excludes service and E2E markers. Use the
smallest focused file while iterating, then the package gate.

## MCP

MCP Vitest suites cover tool schemas, proxy behavior, multi-tab routing,
pipeline errors and authenticated parity with the browser remote-training
client. An RPC contract change also requires the matching frontend
`BrowserRPCHandler` test.

## Cross-boundary rule

- Stereotype or NNTree changes: type-engine tests plus convert/forward tier.
- RPC payload changes: frontend handler and MCP tool tests.
- Generated Hydra/runtime changes: focused Python tests plus relevant frontend
  integration tier.
- Persistence or scheduling changes: fast tests first, then real-Valkey service
  tests and E2E when lifecycle behavior changes.
- Model-package changes: exporter tests plus download/install/load/predict E2E.

Commands and package-specific expectations live in the nearest `AGENTS.md`.
