---
id: T03
kind: task
status: superseded
plan: ../plan.md
superseded_by: ../../package-backend-standard/tasks/P03-runtime-and-training.md
role: backend
depends_on: [T01]
parallel_with: [T02]
write_scope:
  - converted/src/stereotype_runtime/
  - converted/src/package_runtime/
  - converted/src/tests/test_package_runtime.py
---

# Implement the Python package runtime and graph compiler

## Objective

Load an already validated package bundle inside the worker environment and
compile its semantic graph by calling package `build()` factories through a
small, versioned Python runtime contract.

## Context required

- [Initiative plan](../plan.md)
- Accepted T01 runtime contract.
- `stereotype-packages/core/*/pytorch.py`
- `converted/src/net/base.py`
- `converted/src/ops/subflow.py`
- `converted/src/convert.py`
- `converted/src/backend/config_service.py`

## Invariants

- No PyTorch execution is used for frontend type inference.
- Package IDs and versions are validated before import; imports use a unique
  controlled namespace and never a user-provided module path.
- `Input` is a graph boundary, `Fork` is the canonical internal pass-through,
  joins use target-handle order, and hidden subflow nodes remain executable.
- `build()` receives validated primitive parameters and explicit context/services;
  dependency and recursive subflow construction are bounded.

## Allowed files

- New runtime/loader/compiler modules under the listed `converted/src/`
  directories.
- The dedicated runtime unit test file.

## Out of scope

- FastAPI upload/storage wiring and engine-specific container execution.
- Broad refactoring of the historical NNTree runtime.

## Work

1. Implement `stereotype_runtime.pytorch` types and helpers for dtypes,
   `BuildContext`, references and service interfaces.
2. Implement package manifest/resource validation and deterministic dependency
   resolution.
3. Implement graph compilation for layers, joins, subflows and dynamic
   stereotype/subflow services, preserving parameter and handle semantics.
4. Add tests for Linear, Add/Concat, Repeat/HorizontalRepeat, loss modules,
   invalid dependencies, import rejection, ordered joins and nested subflows.

## Acceptance criteria

- [ ] The valid fixture graph builds a `torch.nn.Module` without importing the
      frontend or executing Lua.
- [ ] Missing/duplicate/mismatched package resources fail before factory calls.
- [ ] Package runtime errors preserve an actionable package/phase context.
- [ ] Existing NNTree runtime tests remain unaffected.

## Validation

```bash
cd converted && uv run pytest src/tests/test_package_runtime.py -q
cd converted && uv run pytest src/tests/ -m fast -q
```

## Required handoff

Return the runtime contract, compiler entrypoint, fixture graph, exact import
policy and any assumptions required by the API/container tasks.
