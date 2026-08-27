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
containment and ordered handles without package-ID dispatch tables. Implement
the accepted separate prediction/objective program contract and declarative
external target bindings described in
[`prediction-objective-programs`](../../../../knowledge/decisions/prediction-objective-programs.md).
The two programs share one module store and parameter set.

Implement a package-native typed trainer. It must apply or reject every field
in the public training schema, seed before model/dataset/loader creation,
record normalized configuration and fail clearly for unsupported datasets,
optimizers, accelerators or W&B modes. Dataset classes come only from a
backend registry and operator-managed data roots.

Acceptance: importing the runtime in FastAPI is impossible by construction;
CrossEntropy, regression and target-free KL objectives work without Python
signature, shape/dtype, class or package-ID dispatch; prediction works without
a target; ignored UI fields and non-deterministic initialization regressions
have behavioral tests. Follow the focused
[`prediction/objective implementation plan`](../../prediction-objective-programs/plan.md)
for task boundaries and gates.

Validation:

```bash
cd converted && uv run pytest src/tests/test_package_runtime.py src/tests/test_package_worker.py -q
```
