---
id: P01
kind: task
status: ready
plan: ../plan.md
role: architecture
depends_on: []
write_scope:
  - converted/src/backend/models.py
  - converted/src/backend/manager.py
  - converted/src/backend/executors/
  - converted/src/convert.py
  - converted/src/tests/
---

# Freeze package-only backend and remove NNTree dependencies

Define the package-only API and typed training/resource contracts. Remove
NNTree branches from the backend scheduler and submission materialization.
Before deleting a module, prove with import/dependency checks that it is not
used by the package compiler, worker or wheel exporter. Remove the worker's
legacy fixture path and update tests to package fixtures.

Keep pairing, Valkey, job lifecycle, SSE, logs and cancellation. The portable
wheel contract is retained, but its implementation may not depend on
NNTree/Hydra configuration.

Acceptance: `network.format="nntree"` is rejected; package jobs have no host
executor fallback; `rg` shows no package-path import of `convert.py`,
`config_service.py`, `LocalExecutor` or `SlurmExecutor`.

Validation:

```bash
cd converted && uv run pytest src/tests/ -m fast -q
git diff --check
```
