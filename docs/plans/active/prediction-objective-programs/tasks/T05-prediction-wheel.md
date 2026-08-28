---
id: T05
kind: task
status: ready
plan: ../plan.md
role: backend
depends_on: [T03]
parallel_with: [T04]
write_scope:
  - converted/src/model_package/
  - converted/src/tests/test_model_package.py
  - docs/knowledge/contracts/model-package.md
---

# Export only target-free prediction semantics

## Objective

Make the installed wheel's public API execute the declared prediction program
even when the source training graph contains an objective region.

## Context required

- [Portable model-package contract](../../../../knowledge/contracts/model-package.md)
- [Accepted execution decision](../../../../knowledge/decisions/prediction-objective-programs.md)
- T03 compiled-program and state-dict handoff

## Invariants

- `Model`, the compatibility `load_model` factory, `predict_tensor` and
  `predict` are the complete public API for this task's prediction-only wheel
  v1. Any stereotype-declared wheel adapter is the separate, opt-in T09 surface
  documented in the
  [wheel-adapter decision](../../../../knowledge/decisions/wheel-adapters.md);
  it does not change this task's target-free prediction path.
- The wheel is independent of the checkout and training dataset.
- Safetensors restore strictly against the one shared trained state.
- Public inference cannot require or fabricate targets.

## Work

1. Add failing clean-wheel tests for a classifier graph containing Cross
   Entropy and a VAE graph containing MSE plus KL.
2. Export the explicit prediction descriptor and required package closure.
3. Load the shared trained state and expose only prediction through the public
   facade.
4. Make `Model()` load embedded weights by default and accept only a strictly
   compatible, architecture-fingerprinted local safetensors override;
   `load_model()` delegates to the same facade.
5. Delete `_load_resolved_config()`, YAML/JSON fallback handling, the legacy
   GraphNet/config branch and internal-access assumptions once package-native
   fixtures cover their remaining invariants.
6. Replace the current resolved-config/NNTree model-package documentation with
   the package graph and explicit prediction-descriptor contract once tests
   prove the new wheel behavior.

## Acceptance criteria

- [ ] Classifier `predict_tensor` returns `[B, C]` logits without a target.
- [ ] VAE `predict_tensor` returns the declared reconstruction tensor.
- [ ] `from nnm_<suffix> import Model` loads embedded weights, while an
      incompatible local safetensors override fails before inference.
- [ ] Tests do not access `.network`, `modules_by_id` or repository runtime
      imports.
- [ ] Objective modules are not invoked during inference.
- [ ] Wheel construction has no resolved-config or `_target_` input variant.
- [ ] The current model-package KB describes the implemented package-native
      wheel and no longer requires a resolved NNTree/Hydra configuration.

## Validation

```bash
cd converted && uv run pytest src/tests/test_model_package.py -q
```

## Required handoff

Return wheel contents, public-API proofs, exact test results and any legacy
runtime code that cannot yet be deleted.
