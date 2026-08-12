# Review: Integration Testing Framework — Issues Found

**Date**: 2026-06-28
**Design doc**: `docs/archive/completed-plans/integration-testing-framework.md`
**Verdict**: Issues found — 2 blocker, 3 major, 3 minor

---

## 🔴 Blocker Issues

### B1. Existing unit test config includes integration tests

**File**: `front-end/vitest.config.ts`, line 11
**Severity**: Blocker

`include: ["src/__tests__/**/*.test.ts"]` matches integration test files. Running `pnpm test` will attempt integration tests with wrong config (5000ms timeout, no forks pool).

**Fix**: Add `exclude: ["src/__tests__/integration/**"]` to `vitest.config.ts`.

### B2. `runTraining` silently drops critical Hydra overrides

**File**: `front-end/src/__tests__/integration/helpers.ts`, lines 256–264
**Severity**: Blocker

The `safeOverrides` filter skips `trainer.enable_progress_bar` and `wandb.mode`. This means wandb may try to connect online, causing failures in CI. Use Hydra's `+` prefix instead of filtering.

---

## 🟠 Major Issues

### M1. `any` type in TypeScript

**File**: `front-end/src/__tests__/integration/smoke.test.ts`, lines 83 and 116
**Severity**: Major

`tree.nodes as Record<string, any>` — `any` is forbidden per AGENTS.md. Replace with proper types.

### M2. Missing `trainer.devices` override

**File**: `front-end/src/__tests__/integration/helpers.ts`, lines 250–253
**Severity**: Major

Only `trainer.accelerator` is set without `trainer.devices`. Add `trainer.devices=1` for CPU, `trainer.devices=auto` for GPU.

### M3. `ckptDir` returns wrong path

**File**: `front-end/src/__tests__/integration/helpers.ts`, line 288
**Severity**: Major

`ckptDir: cfgDir` — training outputs go to CWD (PROJECT_ROOT), not cfgDir. infer.test.ts will never find checkpoints.

---

## 🔵 Minor Issues

### m1. Empty `nntrees` section in manifest.json

**File**: `examples/manifest.json`, line 79
**Severity**: Minor

`"nntrees": {}` — add entries for the 6 NNTree files.

### m2. README testing section not updated

**File**: `converted/README.md`, lines 160–167
**Severity**: Minor

Still says "103 tests across 4 files". Add test_main.py and test_infer.py.

### m3. Missing `NNM_DEVICE_COUNT` env var

**Severity**: Minor

Design doc specifies this but it's not implemented anywhere.
