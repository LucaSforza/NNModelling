---
id: P03
kind: task
status: ready
plan: ../plan.md
role: backend
depends_on: [P01, P02]
write_scope:
  - converted/src/package_runtime/
  - converted/src/stereotype_runtime/
  - converted/src/package_worker.py
  - converted/src/tests/
---

# Build the worker-only runtime and trainer

Move all package loading, factory invocation and graph compilation into the
worker image. Validate exact package identity, dependency closure, parameters,
containment and ordered handles without package-ID dispatch tables. Define an
explicit objective/loss interface that carries targets and supports nested
subflows and joins.

Implement a package-native typed trainer. It must apply or reject every field
in the public training schema, seed before model/dataset/loader creation,
record normalized configuration and fail clearly for unsupported datasets,
optimizers, accelerators or W&B modes. Dataset classes come only from a
backend registry and operator-managed data roots.

Acceptance: importing the runtime in FastAPI is impossible by construction;
CrossEntropy and regression objectives both work; ignored UI fields and
non-deterministic initialization regressions have behavioral tests.

Validation:

```bash
cd converted && uv run pytest src/tests/test_package_runtime.py src/tests/test_package_worker.py -q
```
