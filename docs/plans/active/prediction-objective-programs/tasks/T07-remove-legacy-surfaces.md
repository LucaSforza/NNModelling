---
id: T07
kind: task
status: ready
plan: ../plan.md
role: integration
depends_on: [T01]
parallel_with: [T03, T04, T05]
write_scope:
  - front-end/src/components/TrainingSidebar.svelte
  - front-end/src/training/
  - front-end/src/sync/BrowserRPCHandler.ts
  - front-end/src/__tests__/BrowserRPCPackageOnly.test.ts
  - front-end/src/__tests__/trainingApi.test.ts
  - mcp-server/src/
  - mcp-server/__tests__/
  - docs2/
  - converted/README.md
  - converted/AGENTS.md
  - mcp-server/AGENTS.md
  - docs/knowledge/architecture/overview.md
  - docs/knowledge/architecture/browser-mcp.md
  - docs/knowledge/architecture/remote-training.md
  - docs/knowledge/contracts/pairing.md
---

# Remove public NNTree and Hydra surfaces

## Objective

Remove NNTree conversion, Hydra overrides and legacy conversion documentation
from the frontend, browser RPC and MCP server while backend package work
continues in non-overlapping files.

## Context required

- [Package backend decision](../../../../knowledge/decisions/package-backend-standard.md)
- [Prediction/objective decision](../../../../knowledge/decisions/prediction-objective-programs.md)
- `mcp-server/src/tools/conversion.ts`, `mcp-server/src/pipeline.ts`
- `front-end/src/sync/BrowserRPCHandler.ts` and training request UI/types
- current docs2 architecture, API, user, training and examples pages

## Invariants

- DiagramCore remains the sole live graph authority.
- MCP remains a thin browser proxy and does not implement a replacement graph.
- Package training continues through the authenticated FastAPI API.
- This task does not edit package compiler, worker, exporter or dependency
  files owned by T03–T05 and T08.
- Archived historical documents are not rewritten as current guidance.

## Removal map

- Delete MCP `compile_nntree` and `execute_conversion` tools, their registrations
  and tests.
- Delete the NNTree-to-`convert.py` subprocess path and Hydra training argument
  construction from `mcp-server/src/pipeline.ts`; retain only package-relevant
  proxy behavior that has an active caller.
- Delete the browser `compile_nntree` RPC method and replace its negative
  compatibility test with proof that the method is unknown.
- Remove Hydra override UI, request fields and serializers from frontend
  training. Typed package fields remain the only training controls.
- Rewrite docs2, current knowledge, README and local agent guidance around
  DiagramCore package bundles, container training and portable wheels.

## Test migration

Tests that assert an old tool or field exists are deleted. Tests whose invariant
remains relevant are rewritten from the package user's point of view: unknown
RPC rejection, package graph export, typed training submission, thin MCP proxy
behavior and absence of a conversion subprocess.

## Acceptance criteria

- [ ] MCP tool discovery contains no conversion/NNTree tool.
- [ ] Browser RPC rejects `compile_nntree` as unknown.
- [ ] Frontend requests contain no free-form Hydra overrides.
- [ ] No current user, API, architecture, training, example or agent document
      instructs users to run NNTree-to-Hydra conversion.
- [ ] No replacement graph or hidden compatibility flag is introduced.

## Validation

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir mcp-server test
pnpm run docs
git diff --check
```

## Required handoff

Return removed public methods and fields, rewritten tests, rendered-doc result,
exact validation output and any active caller that still requires a legacy
surface.
