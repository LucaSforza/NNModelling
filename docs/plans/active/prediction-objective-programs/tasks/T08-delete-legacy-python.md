---
id: T08
kind: task
status: ready
plan: ../plan.md
role: backend
depends_on: [T04, T05, T07, package-backend-standard/P04]
parallel_with: []
write_scope:
  - converted/src/convert.py
  - converted/src/main.py
  - converted/src/infer.py
  - converted/src/net/
  - converted/src/ops/
  - converted/src/backend/config_service.py
  - converted/src/backend/executors/
  - converted/src/backend/app.py
  - converted/src/backend/manager.py
  - converted/src/backend/models.py
  - converted/src/tests/
  - converted/pyproject.toml
  - converted/uv.lock
  - examples/nntrees/
  - converted/TODO.md
  - converted/TODO-stereotype-extensions.md
---

# Delete the legacy Python stack and dependencies

## Objective

Delete the unreachable NNTree/Hydra host runtime, migrate any still-valid
behavioral tests to package-native owners, and prune dependencies only after
the package worker and wheel no longer import them.

## Context required

- T04 worker handoff proving no legacy worker fallback
- T05 exporter handoff proving no resolved-config or GraphNet branch
- T07 public-surface handoff
- [Parent P04 ContainerController task](../../package-backend-standard/tasks/P04-container-controller.md)
  proving the container path replaces Local/Slurm execution
- parent plan's explicit-removal boundary and the repository's dirty-worktree
  state

## Invariants

- Scheduler, Valkey, ownership, queue ordering, SSE, logs, heartbeat and
  cancellation remain package-path behavior and are not deleted with legacy
  executors.
- Every package job uses ContainerExecutor; no host-Python fallback is added.
- An operation with package-native semantic value is migrated to its package
  entrypoint/tests before its legacy `converted/src/ops` copy is deleted.
- Dependency removal follows a final import/dependency search; it is not based
  only on names in `pyproject.toml`.
- Historical source may live in Git history or an explicit archived document,
  never as an active runtime flag.

## Dependency and risk map

- `model_package/runtime.py` and exporter must lose Hydra/OmegaConf before the
  dependencies can be pruned; T05 owns that prerequisite.
- `package_worker.py` must lose `_run_legacy()` and legacy package loading before
  `convert.py`, `net/` and `ops/` disappear; T04 owns that prerequisite.
- Legacy backend tests currently mix valuable scheduler/ownership assertions
  with Local/Slurm and NNTree fixtures. Preserve the former using package
  submissions and ContainerExecutor fakes; delete only obsolete expectations.
- `ops/` contains reusable tensor behavior as well as Hydra adapters. Search
  imports and compare package entrypoints before each deletion; migrate missing
  package coverage instead of copying the whole legacy abstraction.
- Lockfile pruning may remove transitive OmegaConf only after no direct or
  transitive active dependency requires it. Lightning, W&B and torchmetrics are
  independently audited rather than assumed to be Hydra-only.

## Removal and rewrite map

1. Prove with import and call-site searches that package code does not reach
   `convert.py`, `main.py`, `infer.py`, `net/`, legacy `ops/`, config service or
   Local/Slurm executors.
2. Rewrite scheduler, storage, API and lifecycle tests around package payloads
   and container executor fakes; keep rejection coverage for
   `network.format="nntree"`.
3. Migrate relevant join, subflow, repeat and tensor-operation invariants to
   package runtime or stereotype-package tests.
4. Delete legacy entrypoints, runtime directories, executors, config wiring,
   NNTree fixtures and tests whose only contract is retired behavior.
5. Remove Hydra/OmegaConf and any now-unused Lightning/W&B/torchmetrics direct
   dependencies, regenerate the lockfile and verify a clean environment.
6. Run a final active-source search. Matches outside `docs/archive/` must be
   either removed or be an explicit current prohibition reviewed in handoff.

## Acceptance criteria

- [ ] `network.format="nntree"` is rejected by typed API tests.
- [ ] No package path imports or invokes the deleted Python stack.
- [ ] No Local/Slurm or host-Python executor remains registered or tested as a
      supported path.
- [ ] No active test requires NNTree, Hydra, OmegaConf, resolved configs or
      `_target_` construction.
- [ ] Hydra and OmegaConf are absent from direct dependencies and the lockfile
      unless a newly identified non-legacy dependency proves otherwise.
- [ ] Package scheduler, ownership, SSE, heartbeat, logging and cancellation
      tests remain active and pass.

## Validation

```bash
cd converted && uv run pytest src/tests/ -m fast -q
pnpm --dir front-end guard:package-only
rg -n "NNTree|nntree|Hydra|hydra|OmegaConf|omegaconf|resolved_config|_target_|LocalExecutor|SlurmExecutor" converted front-end mcp-server docs docs2 --glob '!docs/archive/**'
git diff --check
```

## Required handoff

Return the dependency graph used for each deletion, migrated-vs-deleted test
list, removed dependencies and lockfile proof, exact validation results,
reviewed residual search matches and any file retained temporarily with a
concrete non-backend owner.
