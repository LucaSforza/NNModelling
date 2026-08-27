---
id: nntree-deprecation
kind: migration-record
status: superseded
updated: 2026-08-23
superseded_by: ../package-backend-standard/plan.md
---

# NNTree deprecation tracking (superseded)

On 2026-08-27 the project decided that NNTree is not a backend compatibility
variant for the standard package implementation. The removal work is defined
in [`../package-backend-standard/plan.md`](../package-backend-standard/plan.md).

NNTree remains a supported backend input. This document is an inventory, not
authorization to remove or reinterpret the legacy route. Deletion requires an
explicit user decision after package jobs have equivalent coverage.

## Current package-container seam

- `converted/src/backend/executors/container.py` launches the public
  `package_worker` entrypoint in a short-lived Podman/Docker-compatible
  container.
- `converted/src/package_worker.py` loads declared package manifests and
  `pytorch.py` entrypoints, compiles the semantic package graph and writes
  safetensors/training-summary artifacts.
- `converted/src/backend/package_store.py` and `POST /package-bundles` provide
  authenticated, digest-addressed bundle upload; `POST /jobs` accepts the
  separate `network.format: "package"` variant.
- `nntree` remains a distinct supported path. No package job is silently
  converted to NNTree, and no legacy file is deleted.

## Legacy files and routes to remove only with explicit permission

| Area | Current legacy surface | Removal prerequisite |
| --- | --- | --- |
| Request schema | `converted/src/backend/models.py` — `NetworkPayload.format="nntree"` | Package network contract, migration window and client compatibility proof |
| Submission API | `converted/src/backend/app.py` — `POST /jobs` NNTree payload path | Package upload/reference route with auth, ownership and SSE parity |
| Job materialization | `converted/src/backend/manager.py` — `build_job_hydra_configs` and NNTree submission persistence | Package compiler/runtime and artifact schema parity |
| Host executor | `converted/src/backend/executors/local.py` — `src/main.py` Hydra process | All supported jobs dispatched through the package runtime or an explicitly retained legacy mode |
| Slurm legacy mode | `converted/src/backend/executors/slurm.py` — generated NNTree batch script | Tested package-container/Slurm boundary or documented permanent limitation |
| Converter | `converted/src/convert.py` — NNTree JSON to Hydra config | Existing NNTree clients retired and fixtures migrated |
| Frontend API | `front-end/src/training/api.ts` — `network.format: "nntree"` | Frontend package submission and upload contract shipped |
| Browser RPC | `front-end/src/sync/BrowserRPCHandler.ts` — `compile_nntree` | Package export path and MCP compatibility decision |
| MCP proxy | `mcp-server/src/tools/conversion.ts` — NNTree conversion tools | Replacement tools and explicit MCP deprecation notice |

## Non-goals of this record

- No legacy file is deleted or behaviorally changed here.
- No deprecation deadline is implied.
- Container socket security, GPU passthrough and package trust remain
  operator/design decisions; a working CPU executor is not proof of sandbox
  security.
