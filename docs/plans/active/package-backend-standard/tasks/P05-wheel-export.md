---
id: P05
kind: task
status: ready
plan: ../plan.md
role: backend
depends_on: [P03, P04]
write_scope:
  - converted/src/package_runtime/
  - converted/src/model_package/
  - converted/src/backend/manager.py
  - converted/src/tests/
---

# Export one portable package-native wheel

Replace the NNTree/Hydra-dependent exporter input with a resolved package graph
and exact package resources produced by the worker. Vendor the runtime and
package entrypoints needed for inference, include declarative adapters,
resolved metadata and verified safetensors, and write a deterministic wheel
with `load_model`, `predict_tensor` and `predict`.

The worker computes and commits the wheel digest before the job becomes
`succeeded`. Remove `training_package`, `/training-package` and the raw ZIP
consumer once the wheel gate passes.

Acceptance: a downloaded wheel installs and infers in a clean environment with
no repository checkout, Lightning, W&B or training dataset.

Validation:

```bash
cd converted && uv run pytest src/tests/test_model_package.py src/tests/test_backend_e2e.py -q
```
