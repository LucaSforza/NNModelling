---
id: prediction-objective-programs
kind: plan
status: ready
updated: 2026-08-27
areas:
  - architecture
  - frontend
  - backend
  - testing
  - integration
---

# Prediction and objective programs

## Goal

Compile one package diagram into a target-free prediction program and a
training-only objective program over one shared parameter set. ResNet with an
explicit Cross Entropy node must train and export a normally callable wheel;
the VAE must train with reconstruction plus KL objectives while its wheel
exports reconstruction through the public inference API.

## Current behavior

The worker image exercised by the browser contains a stale compiler that only
passes a target to `torch.nn.MSELoss`. The checkout contains a transitional
change that recognizes `kind: "loss"`, but it uses Python signature inspection
and leaves the objective inside model `forward()`. The trainer also contains a
shape/dtype `_loss()` dispatcher that silently selects MSE or Cross Entropy.

Consequently, a diagram without a loss can appear to train, a diagram with
Cross Entropy can fail in a stale worker, and the transitional classifier
cannot infer without a target. The wheel and trainer do not yet share a stable
execution contract.

## Legacy-removal inventory

The following active surfaces still describe, import or test the retired
NNTree/Hydra path and are included in this initiative:

- Python entrypoints and runtime: `converted/src/convert.py`, `main.py`,
  `infer.py`, `net/`, legacy-only `ops/`, package-worker legacy loaders,
  resolved-config wheel fallbacks, and any remaining Local/Slurm executor or
  Hydra config-service references;
- Python tests and fixtures: NNTree submissions, generated YAML,
  `resolved_config`, `_target_`, `LocalExecutor`, `SlurmExecutor`, legacy
  GraphNet and direct Hydra/OmegaConf construction;
- MCP/browser transport: `execute_conversion`, `compile_nntree`, the Python
  subprocess conversion pipeline and the corresponding Browser RPC method;
- frontend training contract: Hydra override textarea, request fields and tests;
- dependencies: `hydra-core` and its OmegaConf dependency, followed by
  Lightning, W&B and torchmetrics only if the final package path has no active
  import requiring them;
- current guidance: `converted/README.md`, package-local `AGENTS.md`, docs2
  architecture/user/API/training/example pages, MCP documentation and current
  knowledge that still presents NNTree-to-Hydra as supported.

Historical material may remain only under `docs/archive/` and must be clearly
non-normative. Editable package diagrams and package-runtime tests replace
NNTree fixtures as active verification inputs.

## Scope

- version the stereotype definition fields for objective external inputs;
- add an explicit package-driven prediction output role;
- replace the frontend single-terminal rule with role-aware completion;
- compile shared modules into prediction and objective programs;
- normalize registered dataset batches to explicit inputs and targets;
- remove all inferred-loss and signature-dispatch behavior;
- make exported wheels invoke only the prediction program;
- support an opt-in wheel-adapter surface declared by stereotype packages, for
  model capabilities beyond prediction without exposing compiler internals;
- reject incompatible worker images with a typed protocol error;
- prove the complete ResNet and VAE browser-to-wheel paths.

## Non-goals

- target nodes or target edges in the model diagram;
- arbitrary target object paths or multi-target task schemas in v1;
- automatic migration or output guessing for diagrams without `kind: "output"`;
- metric graphs, optimizer graphs or a general training-program DSL;
- changing the Lua type engine into a Python- or dataset-driven engine;
- Kubernetes or broader container-controller redesign.
- preserving an NNTree/Hydra command as a hidden flag or silent fallback.
- treating a dataset adapter as a model-generation API;
- exposing a package's arbitrary Python functions, `CompiledPrograms`,
  `_GraphModule`, `modules_by_id` or subflow implementation objects from a
  wheel.

## Decisions and invariants

- Follow the accepted
  [prediction/objective program decision](../../../knowledge/decisions/prediction-objective-programs.md).
- Package kind and declared bindings are the only execution-role authority.
- Prediction and objective programs share one module store; parameters are
  initialized, optimized, serialized and restored exactly once.
- Dataset source and code remain operator-controlled and execute only inside
  the least-privilege worker container.
- A training request with no explicit output or final objective is rejected
  before the epoch loop. There is no compatibility fallback.
- Join operands retain `targetHandle` ordering in both program regions.
- A target-free package objective receives no target even when the batch has
  one. A target-bound objective fails if its declared source is unavailable.
- The wheel public API never invokes or exposes a requirement for targets.
- The implemented wheel v1 surface is deliberately limited to
  `load_model`, `predict_tensor` and `predict`. It is sufficient for the
  standard prediction program, but it does not make a VAE latent space public.
- The implemented T09 wheel adapter is opt-in and stereotype-declared: its
  stable name, tensor input/output contract and forbidden target policy are
  selected on an explicit graph node and recorded in immutable wheel metadata.
  Its only v1 entrypoint is `module.forward`; it is never discovered through a
  Python symbol, node display name or subflow implementation detail.
- Dataset adapters remain preprocessing boundaries from an external value to a
  declared model input. They cannot sample a model distribution, decode a
  latent tensor or obtain model modules.
- A public wheel adapter must have declared input/output contracts, a target
  policy and, where relevant, an explicit randomness policy. It cannot invoke
  the training-only objective region or receive implicit `batch.targets`.
- A subflow remains private unless a stereotype-declared wheel adapter is
  explicitly bound to that compiled instance. The adapter must reuse the shared
  module store; it must not rebuild or duplicate parameters.

## Contracts and control flow

```text
registered dataset
    -> TrainingBatch(inputs, targets)
    -> CompiledPrograms(shared modules)
         |-> PredictionProgram(inputs) -> declared output
         `-> ObjectiveProgram(inputs, targets) -> scalar objective
                                                 -> backward/optimizer

trained shared state + PredictionProgram
    -> portable wheel
    -> load_model().predict_tensor(inputs)

selected, stereotype-declared wheel adapter
    -> versioned wheel manifest -> generic adapter dispatcher
    -> restricted typed adapter over shared modules -> declared result
```

The objective region begins at every `kind: "loss"` node and includes its
descendants. The prediction output is the one `kind: "output"` node outside
that region. Training executes the objective view; inference executes the
prediction view. Shared upstream nodes are not duplicated.

Worker request and result metadata carry a versioned execution-protocol value.
The worker validates it before loading a browser bundle. A mismatched image
returns a typed compatibility failure rather than executing older semantics.

## TDD sequence

1. Add failing schema and graph-validation tests for explicit output and
   external objective bindings.
2. Add failing compiler tests for separate programs, shared parameter identity,
   Cross Entropy, MSE, target-free KL, ordered scalar composition and inference
   without a target.
3. Add anti-hardcoding tests using different package IDs with equivalent
   declarative roles, plus failures for missing/unknown bindings.
4. Add failing worker tests that require the objective program and prove that
   no output-shape/dtype fallback exists.
5. Add failing wheel tests showing that a training graph containing a loss
   still exposes target-free prediction.
6. Implement the smallest code needed to make each layer pass in order.
7. Rebuild the worker image and run browser-level ResNet and VAE acceptance.

## Task graph

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [T01](tasks/T01-package-contract.md) | `architecture` | — | — | `stereotype-packages/`, package schema tests | Declarative output and objective bindings |
| [T02](tasks/T02-frontend-graph.md) | `frontend` | T01 | T03 | frontend graph/type tests, package diagrams | Role-aware valid diagrams |
| [T03](tasks/T03-dual-program-compiler.md) | `backend` | T01 | T02 | package runtime and focused tests | Shared dual-program compiler |
| [T04](tasks/T04-objective-trainer.md) | `backend` | T03 | T05 | worker, dataset boundary and tests | Explicit objective-driven training |
| [T05](tasks/T05-prediction-wheel.md) | `backend` | T03 | T04 | model-package runtime/exporter and tests | Target-free portable inference |
| [T07](tasks/T07-remove-legacy-surfaces.md) | `integration` | T01 | T03, T04, T05 | frontend, MCP and current documentation | No public NNTree/Hydra surface |
| [T08](tasks/T08-delete-legacy-python.md) | `backend` | T04, T05, T07, parent P04 | — | legacy Python, dependencies and tests | No active NNTree/Hydra runtime |
| [T06](tasks/T06-image-and-real-qa.md) | `integration` | T02, T04, T05, T07, T08 | — | worker image/protocol, integration tests, examples | Current-image browser and wheel proof |
| [T09](tasks/T09-declarative-public-endpoints.md) | `architecture` | T05, T06 | — | package contract, compiler/exporter/runtime design and focused tests | Implemented v1 adapter contract; browser QA pending |

Tasks marked parallel have non-overlapping source ownership. Test files must
stay with the task's subsystem to avoid concurrent edits to one shared test
module.

## Integration and review gates

- T01 must settle schema validation before frontend or compiler integration.
- T03 must prove module and parameter identity before trainer or exporter work.
- T04 cannot retain `_loss()`, a default objective, signature inspection or
  input-as-target fallback in any reachable path.
- T05 must test the public wheel API, not internal `network` or
  `modules_by_id` access.
- T07 may run beside backend implementation because it owns only frontend, MCP
  and documentation surfaces. It must not delete Python runtime code or prune
  dependencies needed by work still in progress.
- T08 deletes the Python stack and dependencies only after T04 and T05 prove
  package-native replacements and P04 of the parent package-backend plan proves
  the ContainerController replacement. Behaviorally relevant tests are
  migrated before their legacy fixtures are removed.
- T06 must build a fresh image by digest, prove its protocol metadata, and use
  the Codex in-app Browser for both submissions.
- T09's v1 contract is recorded in the
  [wheel-adapter decision](../../../knowledge/decisions/wheel-adapters.md).
  It binds `wheelAdapters` selected on explicit root-graph nodes to existing
  compiled modules through `module.forward`; it cannot turn `pytorch.py` into a
  general wheel callback surface. Browser submission/download QA remains open.
- Review blocks completion on package-ID/class dispatch, inferred roles,
  duplicate parameters, objective execution during prediction, stale image
  configuration, or legacy tests that preserve forbidden behavior.

## Acceptance criteria

- [ ] Cross Entropy receives MNIST labels only through its declared
      `batch.targets` binding.
- [ ] MSE uses the same binding mechanism; KL declares and receives no target.
- [ ] Composite VAE objective nodes can consume MSE and KL scalar values.
- [ ] Disconnected outputs/losses, incomplete objective joins, outputs inside
      the objective region and multiple objective terminals fail validation.
- [ ] Equivalent role declarations behave identically under different package
      IDs.
- [ ] `PredictionProgram` and `ObjectiveProgram` reference one shared parameter
      set and preserve ordered joins and nested subflows.
- [ ] The trainer has no output-shape, target-dtype, Python-class, package-ID or
      callable-signature objective selection.
- [ ] ResNet with explicit Output and Cross Entropy trains from the browser and
      its downloaded wheel returns `[B, 10]` logits without a target.
- [ ] VAE with explicit Output, MSE, KL and scalar addition trains from the
      browser and its downloaded wheel reconstructs `[B, 1, 28, 28]` through
      `predict_tensor()`.
- [ ] The VAE example uses only the installed wheel's public API and produces a
      visually inspected reconstruction sheet. It does not claim latent-space
      interpolation until a public endpoint contract exists.
- [ ] A VAE stereotype's explicitly selected adapter, when declared, is
      callable through the generic wheel API; the example never reaches
      encoder/decoder modules or a package Python symbol directly. Browser
      proof for this adapter remains pending under T09/T06.
- [ ] A stale execution-protocol image fails before bundle compilation with a
      typed, actionable error.
- [ ] No active frontend, MCP, backend, test or current-documentation path
      exposes NNTree, Hydra, OmegaConf, `_target_`, resolved configs or a host
      Python executor.
- [ ] Final dependency and source searches find historical terms only under
      explicitly archived documentation.

## Final verification

Run from the repository root unless noted otherwise:

```bash
pnpm --dir front-end check
pnpm --dir front-end test
cd converted && uv run pytest src/tests/test_package_runtime.py src/tests/test_package_worker.py -q
cd converted && uv run pytest src/tests/test_model_package.py src/tests/test_backend_e2e.py -q
cd converted && uv run pytest src/tests/ -m fast -q
pnpm --dir mcp-server test
git diff --check
```

The final source audit must cover active code, tests and current documentation:

```bash
rg -n "NNTree|nntree|Hydra|hydra|OmegaConf|omegaconf|resolved_config|_target_|LocalExecutor|SlurmExecutor|compile_nntree|execute_conversion" front-end mcp-server converted docs docs2 --glob '!docs/archive/**'
```

Expected matches are zero unless a current package-native document names a
retired term solely to state a prohibition. Such exceptions must be reviewed
individually; a broad ignore pattern is not acceptable.

After these gates, run one one-epoch CPU ResNet smoke job and one bounded CPU
VAE job through the Codex in-app Browser, download both wheels, install each in
a clean temporary environment and exercise only its public API. Run the same
controller contract against Podman and Docker when both engines are available;
an unavailable engine is reported as an environmental limitation, not a pass.

## Knowledge and archive impact

- T05 migrates the current model-package contract from resolved NNTree/Hydra
  configuration to a package graph plus explicit prediction descriptor when
  the implementation makes that contract true.
- T09 records the implemented stereotype-declared adapter contract in
  [wheel-adapters](../../../knowledge/decisions/wheel-adapters.md). Its focused
  Python coverage is present; browser submission/download QA is still required
  before the task can complete.
- Update the current package type-system contract when role-aware graph
  completion lands.
- Record the worker protocol and image lifecycle in operations knowledge after
  T06.
- When this focused initiative and its parent package-backend tasks pass, move
  the plan to `docs/archive/completed-plans/` with only durable QA evidence.
