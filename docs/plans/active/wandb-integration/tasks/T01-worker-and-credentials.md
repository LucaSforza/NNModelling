---
id: T01
kind: task
status: done
plan: ../plan.md
role: backend
depends_on: []
parallel_with: [T02, T03]
write_scope:
  - converted/src/package_worker.py
  - converted/src/training/wandb_tracking.py
  - converted/src/backend/wandb_credentials.py
  - converted/src/backend/wandb_admin.py
  - converted/pyproject.toml
  - converted/uv.lock
  - converted/src/tests/test_wandb_tracking.py
  - converted/src/tests/test_package_worker.py
  - converted/src/tests/test_wandb_admin.py
---

# Implement the worker tracker and administrator credentials

## Objective

Provide the sole W&B SDK integration in the package worker and a safe local
administrator lifecycle for the shared credential file.

## Context required

- Read the [initiative](../plan.md), the
  [package backend decision](../../../../knowledge/decisions/package-backend-standard.md),
  `converted/AGENTS.md`, and the current package worker.
- Inspect `_normalized_training`, `_validate_training_support`, and the current
  epoch loop before editing.

## Invariants

- No W&B code runs in FastAPI and no package ID controls logging behavior.
- The secret is read only from the bounded stdin protocol for online mode and is
  never printed or persisted by the worker.
- Offline and disabled need neither credentials nor network.
- Online SDK failures propagate; there is no fallback.
- Do not upload the dataset, wheel, weights, or another W&B Artifact.

## Allowed files

Only the files in `write_scope`. The new modules own credential-file parsing and
worker SDK lifecycle; controller transport and HTTP contracts belong to T02.

## Out of scope

- Container engine arguments, proxy/network policy, API endpoints, frontend UI,
  archived Hydra/Lightning code, and documentation outside this task file.

## Work

1. Add `wandb>=0.22.3` and update the lockfile.
2. Implement strict versioned credential parsing, atomic owner-only storage,
   sanitized status, interactive connect with verification, and disconnect.
3. Implement the fixed worker stdin flag with a small maximum payload and EOF;
   read it before package compilation and close stdin before package code runs.
4. Implement one tracker supporting disabled/offline/online, artifact-local SDK
   directories, normalized config, epoch/final metrics, deterministic run name,
   explicit finish behavior, and atomic `wandb-run.json`.
5. Remove the worker's non-disabled rejection and route the existing loop through
   the tracker without changing training semantics.
6. Add isolated SDK doubles plus a real offline-mode regression test that never
   uses the network.

## Acceptance criteria

- [ ] The admin commands never accept or emit the key in argv/output and persist
      only a mode-0600 credential file after successful verification.
- [ ] Disabled, offline, and online have the exact semantics fixed by the plan.
- [ ] Training metrics/config and `wandb-run.json` are correct and contain no key.
- [ ] No changes outside `write_scope`.

## Validation

```bash
cd converted && uv run pytest src/tests/test_wandb_tracking.py src/tests/test_wandb_admin.py src/tests/test_package_worker.py -q
```

## Required handoff

Return changed files, exact tests/results, assumptions, risks, and any integration
expectations T02 must satisfy. Do not expose a test credential in the handoff.
