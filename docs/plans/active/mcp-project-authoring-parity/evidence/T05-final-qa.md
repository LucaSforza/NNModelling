# T05 final QA evidence

**Run date:** 2026-09-14
**Result:** PASS — automated gates and disposable live UI/MCP QA passed.

## Automated gates

| Gate | Result | Evidence |
| --- | --- | --- |
| `pnpm --dir front-end check` | Pass | 0 errors; 35 warnings across 8 files. |
| `pnpm --dir front-end test` | Pass | 50 files; 302 tests passed. |
| `pnpm --dir front-end guard:package-only` | Pass | `package-only guard: ok` with the current `data.package` identity contract (`id` and `version`). |
| `pnpm --dir mcp-server test` | Pass | TypeScript build succeeded; 7 files and 74 tests passed. |
| `git diff --check` | Pass | No whitespace errors. |

The implementation owner also reported 10/10 focused authoring tests passing. The full frontend suite above was rerun after the final runtime dependency-resolution fix.

## Disposable live-project QA

Used a temporary copy of the existing VAE project at `/tmp/nnmodelling-t05-commit-qa`; all live authoring and failure injection targeted this clone. The public MCP registry exposed all four authoring tools.

- Created semantically equivalent stereotypes through the UI (`qa.ui-layer`) and MCP (`qa.mcp-layer`). Their project folders contained the expected four package files and appeared in the live catalog.
- Created equivalent named-slot datasets through the UI (`qa.ui-dataset`) and MCP (`qa.mcp-dataset`), plus an MCP dataset with `dataFiles`. The manifests, generated source and live catalog reflected the submitted contracts; `data/probe.bin` contained exactly `00 01 02 03 04`.
- Created `qa.guard-target` and `qa.guard-dependent` through MCP. Runtime diagnostics were clear, and deleting the target while required was rejected with “required by another project stereotype” and no mutation. Deleting the dependent then allowed the target deletion.
- Core stereotype deletion and deletion of graph-used `example.vae.sampling@0.1.0` were both rejected without mutation.
- UI cancellation of `qa.mcp-dataset` left it listed and present. Confirmed UI deletion then removed it. UI deletion of `qa.ui-layer` and MCP deletion of `qa.mcp-layer`, `qa.ui-dataset` and the file-backed dataset succeeded through their respective paths.
- Injected an `EACCES` failure by removing write permission from the package parent before deleting `qa.ui-layer` through MCP. The operation failed; SHA-256 hashes of `model.json` and all stereotype files were unchanged, the package remained, and the parent permission was restored.
- Reopened the clone through MCP. The existing VAE graph returned as Saved with `resourceCount: 17`, and no QA resources remained in its project folders or catalogs.

The earlier live failure of the dependency guard is superseded by this run: the latest runtime resolves dependency ranges against the complete package scope, and the live guard now rejects the dependent deletion before mutation.

## Cleanup and final state

Removed the disposable project and rollback snapshots. Stopped the temporary-root MCP server and restarted the local server against the repository's existing `Variational Autoencoder` project (`example.vae-mnist`, `resourceCount: 17`). The original project opened successfully in the in-app editor. `git status --short -- examples/` is empty; no QA changes remain in `examples/` or `transformer.spam`.
