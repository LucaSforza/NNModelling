# Observable nodes — implementation plan

**Status:** Ready for delegation  
**Architecture:** `docs/designs/observable-nodes/architecture.md`  
**Requirements:** `analysis/requirements/oberver.md`

Every implementer must read `AGENTS.md`, the full requirements file, and the
architecture document before editing. Existing user changes in
`analysis/requirements/`, `analysis/uml/nn.vpp`, and
`analysis/uml/.nn.vpp.lck` are out of scope and must be preserved.

## Task 1 — Frontend model, stereotypes and visual node

**Agent:** `frontend-openai`

**Objective:** Make Observable nodes first-class browser diagram elements with
stereotype-defined fixed inputs and no outputs.

**Likely files:**

- `Stereotypes/Observables/*.json`
- `front-end/src/core/StereotypeCore.ts`
- `front-end/src/core/DiagramCore.ts`
- `front-end/src/nodes/ObservableNode.svelte`
- `front-end/src/styles/observable.css`
- `front-end/src/FlowCanvas.svelte`
- `front-end/src/components/Sidebar.svelte`
- `front-end/src/core/validation.ts`
- `front-end/src/sync/BrowserRPCHandler.ts`
- focused frontend tests
- MCP stereotype cache/tool tests if required by the established RPC path

**Constraints:**

- Load Svelte and Vitest skills before implementation.
- Follow the designer brief: violet dotted passive-monitor identity, visible
  disabled state, semantic ordered input labels, no source handle.
- Reuse ordinary edges; reject Observable-as-source connections.
- Preserve import/export, undo/redo and default parameter merging.
- Do not edit Python runtime files in this task.

**Acceptance:** Both initial stereotypes can be created from UI and MCP,
connected from a normal `out` handle, edited and serialized; no source handle
exists; existing editor tests pass.

**Validation:** Focused Vitest tests, full `pnpm --dir front-end test`,
`pnpm --dir front-end check`, and relevant MCP server tests/build if changed.

## Task 2 — Compiler and isolated type checking

**Agent:** `frontend-openai`, sequentially after Task 1

**Objective:** Partition computational and observation graphs, emit the agreed
`interpretability` contract, and validate Observable inputs without output type
propagation.

**Likely files:**

- `front-end/src/conversion/nnTree.ts`
- `front-end/src/conversion/tensortypes.ts`
- `front-end/src/conversion/typeEngine.ts`
- `front-end/src/__tests__/nnTree.test.ts`
- `front-end/src/__tests__/typeEngine.test.ts`
- integration helpers/fixtures where needed

**Constraints:**

- All existing NNTree traversal receives only computational edges/nodes.
- Observation edges never enter children lists, cycle checks or model order.
- Preserve visual `moduleId` metadata for runtime source binding.
- Inputs are ordered by `targetHandle`.
- Observable diagnostics cannot block unrelated computational nodes.
- Support top-level and nested subflow source IDs where the current diagram
  model permits them.

**Acceptance:** Compilation emits no Observable in `nodes`; emits complete,
ordered `interpretability.observables`; a model's computational topology is
unchanged when Observables are attached; the type result has Observable input
annotations and no Observable output type.

**Validation:** New compiler/type tests, all frontend unit tests, smoke
integration compilation of existing examples and one Observable fixture.

## Task 3 — Python conversion and runtime

**Agent:** `backend-openai`

**Objective:** Convert the new section into Hydra configuration and execute
passive forward-value analyses through a separate lifecycle manager.

**Likely files:**

- `converted/src/convert.py`
- `converted/src/net/base.py`
- `converted/src/main.py`
- `converted/src/infer.py`
- new `converted/src/interpretability/` package
- focused Python tests and one NNTree fixture

**Constraints:**

- Load Python style, Python testing and PyTorch skills.
- Implement exactly the compiled contract in `architecture.md`.
- Observable implementations are not model layers and never enter
  `module_dict` or `state_dict`.
- Hooks return `None`; values detach by default; model outputs and gradients
  are unchanged.
- Bind compacted sequential layer IDs using compiler-provided `moduleId`.
- Provide global disable, TRAIN/EVAL/PREDICT gating, all finalize phase routing,
  per-instance table ownership, W&B failure isolation and local fallback.
- Do not add dependencies.
- Do not modify exported-wheel behavior beyond preserving compatibility.

**Acceptance:** `ActivationRecorder` and `ActivationStatistics` execute in
their supported modes, finalize at stereotype-defined phases, publish one
table per instance when W&B is available, persist locally otherwise, and leave
model output/state_dict unchanged.

**Validation:** Focused pytest tests for implementations, lifecycle, conversion,
mode gating, W&B mock and fallback; existing fast Python suite; end-to-end
handwritten NNTree → Hydra → `Net.forward` test.

## Task 4 — Cross-package integration and browser-backed E2E

**Agents:** `frontend-openai` for frontend fixture/browser defects;
`backend-openai` for conversion/runtime defects. Execute sequential repairs to
avoid overlapping files.

**Objective:** Verify the complete source diagram flow and backward
compatibility using the NNModelling MCP skill.

**Procedure:**

1. Run full frontend, MCP and fast Python checks.
2. Start/reuse the stack through
   `.agents/skills/nnmodelling-mcp/scripts/nnm-stack.sh`.
3. Select the connected browser tab explicitly.
4. Create a small type-correct graph and attach one
   `ActivationStatistics` Observable through MCP tools.
5. Confirm type information has Observable inputs and no output.
6. Confirm graph validation and NNTree compilation succeed and the Observable
   appears only in `interpretability`.
7. Convert and run a deterministic forward/training smoke path with W&B
   disabled/offline; verify local result metadata.
8. Compare model outputs with globally enabled and disabled Observables.
9. Capture a readable screenshot showing the Observable and its connection.
10. Load/compile at least one existing diagram to confirm compatibility.

**Acceptance:** All source acceptance criteria are supported by automated or
browser-backed evidence; no console/runtime errors; no leaked stack processes.

## Task 5 — Review and repair

**Agent:** `reviewer-openai`

Review the full user requirement, both design files, complete diff and test
evidence. Pay particular attention to:

- accidental computational dependencies or output changes;
- sequential/subflow source binding;
- autograd and memory leaks;
- finalize phase correctness and duplicate flushes;
- W&B-disabled behavior and table isolation;
- type-diagnostic severity and conversion gates;
- compatibility with existing diagrams/configs;
- tests that prove behavior rather than only schema shape.

Every actionable finding returns to the corresponding selected implementer.
Repeat validation and review until approved or a genuine user blocker remains.
