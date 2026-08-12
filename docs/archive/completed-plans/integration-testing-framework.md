> **Archived:** historical implementation record; not authoritative current documentation.

# Integration Testing Framework — Design Specification

**Date**: 2026-06-28  
**Status**: Draft — awaiting approval  
**Author**: NNModelling Architect

---

## 1. Objective

Build a comprehensive integration testing framework that validates the entire NNModelling pipeline end-to-end: from Svelte Flow diagram JSON all the way through Python training and inference. The framework must be:

- **Orchestrated from npm** — single-command execution
- **Parametric by diagram** — `NNM_DIAGRAM=<name>` selects which architecture to test
- **Multi-tier** — smoke → convert → forward → train → infer (user chooses depth)
- **Device-configurable** — CPU (default) or GPU via `NNM_DEVICE`
- **CI-ready** — clean exit codes, structured output, temp directories

---

## 2. Current State & Gap Analysis

### What exists

| Layer | Tool | Tests | Scope |
|-------|------|-------|-------|
| Front-end unit | vitest | 76 | nnTree.ts compilation, utils |
| Python unit | pytest | 103 | ops, base.py, convert.py |
| Python "integration" | pytest | 11 | convert.py → Net.forward() only |

### What's missing

| Gap | Impact |
|-----|--------|
| **Training loop** (`main.py`) never tested | Don't know if models actually learn |
| **Inference** (`infer.py`) never tested | Output JSON/images never validated |
| **6 of 10 root diagrams never integration-tested** | `single_head_attention`, `multihead_attention`, `horizontal_multihead_attention`, `auto_encoder_submodels`, `auto_encoder_submodels_with_submodels`, `mninst.json` — zero integration coverage |
| **No cross-package orchestration** | Front-end and Python tests are completely independent |
| **No CI/CD** | No `.github/`, no `Makefile` |
| **No coverage tracking** | Neither vitest nor pytest measures coverage |
| **Test JSONs duplicated** across root and `converted/` with different formats | Confusing, error-prone |

### Diagram inventory

**Svelte Flow format** (`{nodes, edges}` — source diagrams, 10 files at project root):

| # | File | Nodes | Edges | Complexity |
|---|------|-------|-------|------------|
| 1 | `mninst.json` | 10 | 9 | Simple sequential MLP |
| 2 | `mnist_skips.json` | 16 | 17 | Skip connections + Addition joins |
| 3 | `autoencoder_mnist.json` | 11 | 11 | Encoder-decoder with skip |
| 4 | `auto_encoder_submodels.json` | 17 | 14 | Autoencoder with SubFlows |
| 5 | `auto_encoder_submodels_with_submodels.json` | 19 | 14 | Nested SubFlows |
| 6 | `single_head_attention.json` | 10 | 11 | Single-head attention from primitives |
| 7 | `multihead_attention.json` | 30 | 40 | 4-head attention via Concat join |
| 8 | `horizontal_multihead_attention.json` | 12 | 12 | 4-head via HorizontalRepeat |
| 9 | `skip_connections_with_repetition.json` | 20 | 19 | Residual + Repeat SubFlow |
| 10 | `transformer_classifier.json` | 24 | 25 | Full transformer classifier |

**NNTree format** (`{root, lossNode, nodes}` — pre-compiled, 6 files in `converted/`):

| # | File | Used by |
|---|------|---------|
| 11 | `auto_encoder.json` | `test_convert.py`, `test_integration.py` |
| 12 | `auto_encoder_nested_submodels.json` | `test_convert.py` |
| 13 | `mninst_skip.json` | `test_convert.py` |
| 14 | `skip_connections_with_repetition.json` | `test_convert.py`, `test_integration.py` |
| 15 | `skip_connections_without_repetition.json` | *(unused — dead file)* |
| 16 | `transformer_classifier.json` | `test_convert.py`, `test_integration.py` |

> **Note**: Files 9/14 and 10/16 share names but have totally different content (different MD5s) because they represent the same logical model in different pipeline stages.

---

## 3. Examples Directory Consolidation

All 16 diagram JSONs move to a single `examples/` directory at project root, organized by format.

### Target structure

```
examples/
├── manifest.json              # Test metadata for each diagram
├── diagrams/                  # Svelte Flow format (10 files — source of truth)
│   ├── mninst.json
│   ├── mnist_skips.json
│   ├── autoencoder_mnist.json
│   ├── auto_encoder_submodels.json
│   ├── auto_encoder_submodels_with_submodels.json
│   ├── single_head_attention.json
│   ├── multihead_attention.json
│   ├── horizontal_multihead_attention.json
│   ├── skip_connections_with_repetition.json
│   └── transformer_classifier.json
└── nntrees/                   # Pre-compiled NNTree format (6 files)
    ├── auto_encoder.json
    ├── auto_encoder_nested_submodels.json
    ├── mninst_skip.json
    ├── skip_connections_with_repetition.json
    ├── skip_connections_without_repetition.json
    └── transformer_classifier.json
```

### `examples/manifest.json` schema

Each diagram entry specifies what the integration tests need to know to run forward passes and training:

```jsonc
{
  "diagrams": {
    "mninst": {
      "format": "svelte-flow",
      "inputShape": [1, 1, 28, 28],
      "numClasses": 10,
      "taskType": "classification",
      "trainable": true,
      "description": "Simple MNIST MLP classifier"
    },
    "autoencoder_mnist": {
      "format": "svelte-flow",
      "inputShape": [1, 1, 28, 28],
      "taskType": "regression",
      "trainable": true,
      "description": "Convolutional autoencoder"
    },
    "single_head_attention": {
      "format": "svelte-flow",
      "inputShape": [2, 16, 64],
      "taskType": "regression",
      "trainable": false,
      "description": "Single-head attention — no trainable params in diagram"
    },
    "transformer_classifier": {
      "format": "svelte-flow",
      "inputShape": [2, 16],
      "inputType": "int",
      "numClasses": 2,
      "taskType": "classification",
      "trainable": true,
      "description": "Full transformer: embed, posenc, encoder×2, pool, linear"
    }
    // ... all 10 Svelte Flow diagrams
  },
  "nntrees": {
    "auto_encoder": {
      "inputShape": [1, 1, 28, 28],
      "taskType": "regression",
      "trainable": true
    }
    // ... all 6 NNTree diagrams
  }
}
```

### Migration steps

1. Create `examples/diagrams/` and `examples/nntrees/`
2. Copy all 10 root `*.json` → `examples/diagrams/`
3. Copy all 6 `converted/*.json` → `examples/nntrees/`
4. Create `examples/manifest.json`
5. Update **Python tests** (`conftest.py`): change `FIXTURES_DIR` from `converted/` to `../../examples/nntrees/`
6. Update `converted/README.md` paths
7. Delete original JSONs from project root and `converted/` (after verifying all references updated)
8. Add `.gitkeep` or keep empty dirs as needed

---

## 4. Test Tier Architecture

The framework is organized into **5 tiers** of increasing depth and cost.

```
Tier 0: SMOKE     (~20s)   nnTree.ts compiles diagram → valid NNTree JSON
Tier 1: CONVERT   (~30s)   NNTree JSON → convert.py → valid Hydra YAML config dir
Tier 2: FORWARD   (~2min)  Hydra config → Net() → forward pass → correct output shape
Tier 3: TRAIN     (~10min) Hydra config → main.py (1 epoch) → loss decreases, checkpoint saved
Tier 4: INFER     (~3min)  Trained checkpoint → infer.py → valid output JSON + images
```

### Tier 0 — Smoke (nnTree compilation)

**What**: Given a Svelte Flow diagram JSON, run it through `nnTree.ts` and verify the output is structurally valid.

**Runner**: vitest (TypeScript, in-process)
**Input**: `examples/diagrams/<name>.json`
**Output**: Pass/fail with structured error messages
**Coverage**: All 10 Svelte Flow diagrams
**Parallel**: Yes (no shared state)

**Assertions**:
- `nnTree.toJson()` returns valid JSON
- Has `root`, `lossNode`, `nodes` keys
- `root` references a valid node ID
- No cycles detected
- Internal subflow structure valid

### Tier 1 — Convert (Hydra config generation)

**What**: Run `convert.py` on the NNTree JSON and verify the output directory structure.

**Runner**: vitest spawns `uv run python src/convert.py ...`
**Input**: NNTree JSON (from Tier 0 output, or pre-compiled from `examples/nntrees/`)
**Output**: Temp directory with valid Hydra YAML configs
**Coverage**: All 10 diagrams (full pipeline) + 6 pre-compiled NNtrees (fast path)
**Parallel**: Yes (separate `tmp_path` per test)

**Assertions**:
- All expected YAML files exist: `base.yaml`, `net/custom_sequence.yaml`, `optimizer/adam.yaml`, `trainer/default.yaml`, `wandb/wandb.yaml`, `dataset/dataset.yaml`, `early_stopping/default.yaml`
- `net/custom_sequence.yaml` parses as valid OmegaConf
- No Python exceptions during conversion
- `convert.py` exit code 0

### Tier 2 — Forward Pass

**What**: Instantiate the model from Hydra config and run a forward pass with a synthetic tensor.

**Runner**: vitest spawns `uv run pytest converted/src/tests/ -k "forward" --json-report`
**Input**: Hydra config dir (from Tier 1)
**Output**: Pass/fail
**Coverage**: 5 key diagrams (mninst, autoencoder_mnist, transformer_classifier, skip_connections_with_repetition, multihead_attention)
**Parallel**: Yes (separate tmp_path per test, CPU tensors)

**Assertions**:
- `Net` can be instantiated from config
- Forward pass produces output tensor of expected shape
- Output requires grad (gradient flow intact)
- No NaN in output

### Tier 3 — Training Smoke

**What**: Run `main.py` for 1 epoch (or N steps) and verify the loss decreases.

**Runner**: vitest spawns `uv run python src/main.py --config-dir <tmp> --config-name base trainer.max_epochs=1`
**Input**: Hydra config dir (from Tier 1)
**Output**: Training log, checkpoints directory
**Coverage**: 2 fast diagrams (mninst, autoencoder_mnist) — others have complex dependencies
**Parallel**: **No** — sequential only (GPU memory, training is resource-heavy)
**Timeout**: 600s per diagram

**Assertions**:
- `main.py` exit code 0
- At least 1 checkpoint file created
- Training loss printed (or logged to wandb in offline mode)
- No CUDA OOM (if GPU)

**Configuration**:
- `trainer.max_epochs=1` (or `trainer.max_steps=10` for large models)
- `trainer.fast_dev_run=true` for ultra-fast smoke
- `wandb.mode=disabled` or `wandb.mode=offline`
- `trainer.enable_progress_bar=false`
- `trainer.log_every_n_steps=1`

### Tier 4 — Inference

**What**: Run `infer.py` on a trained checkpoint and validate output structure.

**Runner**: vitest spawns `uv run python src/infer.py ...`
**Input**: Checkpoint from Tier 3 + Hydra config dir
**Output**: Predictions JSON, optional image outputs
**Coverage**: 2 diagrams (same as Tier 3)
**Parallel**: No (sequential)

**Assertions**:
- `infer.py` exit code 0
- Predictions JSON exists and is valid JSON
- Predictions have correct shape (batch_size × num_classes or batch_size × input_dims)
- Output images generated if `--image-dir` specified

---

## 5. npm Scripts

New entries in `front-end/package.json`:

```jsonc
{
  "scripts": {
    // ... existing scripts ...

    // --- Integration testing ---
    "test:integration":        "vitest run --config vitest.integration.config.ts",
    "test:integration:smoke":  "NNM_TIER=smoke npm run test:integration",
    "test:integration:convert":"NNM_TIER=convert npm run test:integration",
    "test:integration:forward":"NNM_TIER=forward npm run test:integration",
    "test:integration:train":  "NNM_TIER=train npm run test:integration",
    "test:integration:infer":  "NNM_TIER=infer npm run test:integration",
    "test:integration:all":    "NNM_TIER=all npm run test:integration",

    // --- Single diagram testing ---
    "test:example":            "vitest run --config vitest.integration.config.ts",

    // --- Coverage ---
    "test:coverage":           "vitest run --coverage"
  }
}
```

**Usage examples**:

```bash
# Run all tiers on all diagrams
pnpm test:integration:all

# Run only forward pass on a single diagram
NNM_DIAGRAM=transformer_classifier pnpm test:integration:forward

# Run training smoke test on GPU
NNM_DIAGRAM=mninst NNM_DEVICE=gpu pnpm test:integration:train

# Run smoke + convert tiers only
pnpm test:integration:convert    # (includes smoke as dependency)

# Run a single diagram through all tiers
NNM_DIAGRAM=autoencoder_mnist pnpm test:example
```

---

## 6. Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NNM_DIAGRAM` | *(all)* | Diagram name (without `.json`). E.g. `mninst`. When unset, runs all applicable diagrams. |
| `NNM_TIER` | `all` | Which tier(s) to run: `smoke`, `convert`, `forward`, `train`, `infer`, `all` |
| `NNM_DEVICE` | `cpu` | `cpu` or `gpu` (passed to PyTorch as `trainer.accelerator`) |
| `NNM_DEVICE_COUNT` | `1` | Number of devices (for `devices=auto` in Lightning) |
| `NNM_TIMEOUT` | *(tier-dependent)* | Override default timeout per test (seconds) |
| `NNM_WANDB_MODE` | `disabled` | wandb logging mode: `disabled`, `offline`, `online` |
| `NNM_FAST_DEV_RUN` | `false` | If `true`, uses `trainer.fast_dev_run=true` for ultra-fast training smoke |
| `NNM_KEEP_TEMP` | `false` | If `true`, preserves temp directories after test (for debugging) |

### vitest.integration.config.ts

```ts
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [
    svelte({ emitCss: false }),
  ],
  test: {
    include: ["src/__tests__/integration/**/*.test.ts"],
    globals: true,
    testTimeout: 600_000,      // 10 minutes max per test
    hookTimeout: 120_000,      // 2 minutes for setup/teardown
    pool: "forks",             // Child processes (cleaner Python subprocess mgmt)
    sequence: {
      concurrent: false,       // Sequential for GPU training safety
    },
    env: {
      NNM_DEVICE: process.env.NNM_DEVICE || "cpu",
      NNM_DIAGRAM: process.env.NNM_DIAGRAM || "",
      NNM_TIER: process.env.NNM_TIER || "all",
      NNM_WANDB_MODE: process.env.NNM_WANDB_MODE || "disabled",
    },
  },
});
```

> **Tier-dependent timeouts**: Override in individual test files via `test.describe.configure({ timeout: ... })`.

---

## 7. Test Implementation Structure

### File layout

```
front-end/src/__tests__/
├── helpers.ts                          # (existing)
├── nnTree.test.ts                      # (existing — unit tests)
├── utils.test.ts                       # (existing — unit tests)
└── integration/                        # NEW directory
    ├── helpers.ts                      # Shared integration helpers
    ├── smoke.test.ts                   # Tier 0: nnTree compilation
    ├── convert.test.ts                 # Tier 1: convert.py YAML generation
    ├── forward.test.ts                 # Tier 2: Net.forward() pass
    ├── train.test.ts                   # Tier 3: main.py training smoke
    └── infer.test.ts                   # Tier 4: infer.py output validation
```

### Integration helpers (`integration/helpers.ts`)

```ts
import { execSync, spawnSync } from "child_process";
import { resolve } from "path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";

export const PROJECT_ROOT = resolve(__dirname, "../../..");   // NNModelling/
export const EXAMPLES_DIR = resolve(PROJECT_ROOT, "examples");
export const CONVERTED_DIR = resolve(PROJECT_ROOT, "converted");
export const DIAGRAMS_DIR = resolve(EXAMPLES_DIR, "diagrams");
export const NNTREES_DIR = resolve(EXAMPLES_DIR, "nntrees");

/** Read manifest.json */
export function loadManifest(): Manifest { ... }

/** Get the list of diagrams to test based on NNM_DIAGRAM env var */
export function getTargetDiagrams(manifest: Manifest, tier: Tier): DiagramEntry[] { ... }

/** Run convert.py on a JSON file, return path to Hydra config dir */
export function runConvert(jsonPath: string, options?: ConvertOptions): string { ... }

/** Run main.py with Hydra config dir */
export function runTraining(cfgDir: string, options?: TrainOptions): { exitCode: number; ckptDir: string } { ... }

/** Run infer.py */
export function runInference(cfgDir: string, ckptPath: string, options?: InferOptions): { predictions: object } { ... }

/** Spawn a Python process via `uv run`, capture output, check exit code */
export function uvRun(args: string[], opts?: { cwd?: string; env?: Record<string, string>; timeout?: number }): SpawnResult { ... }

/** Create a temp directory (auto-cleaned unless NNM_KEEP_TEMP=true) */
export function tempDir(): string { ... }

/** Load Svelte Flow JSON and compile via nnTree */
export function compileDiagram(diagramPath: string): NnTreeJson { ... }
```

### Tier 0 smoke test pattern

```ts
// smoke.test.ts
import { describe, it, expect } from "vitest";
import { compileDiagram, getTargetDiagrams, DIAGRAMS_DIR, loadManifest } from "./helpers";

const manifest = loadManifest();
const targets = getTargetDiagrams(manifest, "smoke");

describe.each(targets)("Smoke: $name", ({ name }) => {
  it("compiles without errors", () => {
    const nnTree = compileDiagram(resolve(DIAGRAMS_DIR, `${name}.json`));
    expect(nnTree.root).toBeDefined();
    expect(nnTree.lossNode).toBeDefined();
    expect(nnTree.nodes).toBeTypeOf("object");
    expect(Object.keys(nnTree.nodes).length).toBeGreaterThan(0);
  });

  it("produces valid tree structure", () => {
    const nnTree = compileDiagram(resolve(DIAGRAMS_DIR, `${name}.json`));
    // Validate tree invariants
    expect(nnTree.nodes[nnTree.root]).toBeDefined();
    // Check no orphan nodes (all referenced nodes exist)
    for (const [id, node] of Object.entries(nnTree.nodes)) {
      if (node.type === "sequential") {
        for (const childId of node.children) {
          expect(nnTree.nodes[childId]).toBeDefined();
        }
      }
    }
  });
});
```

### Tier 3 training smoke test pattern

```ts
// train.test.ts
import { describe, it, expect } from "vitest";
import { runConvert, runTraining, tempDir, loadManifest, getTargetDiagrams, DIAGRAMS_DIR } from "./helpers";

const manifest = loadManifest();
const targets = getTargetDiagrams(manifest, "train");

describe.each(targets)("Train: $name", ({ name, inputShape, numClasses }) => {
  const timeout = 600_000; // 10 minutes

  it("converts and trains for 1 epoch", { timeout }, () => {
    const cfgDir = tempDir();
    const jsonPath = resolve(DIAGRAMS_DIR, `${name}.json`);

    // Tier 1: Convert
    runConvert(jsonPath, { outputDir: cfgDir, numClasses });

    // Tier 3: Train
    const result = runTraining(cfgDir, {
      maxEpochs: 1,
      fastDevRun: process.env.NNM_FAST_DEV_RUN === "true",
      device: process.env.NNM_DEVICE || "cpu",
    });

    expect(result.exitCode).toBe(0);
    expect(result.ckptDir).toBeDefined();
    // Verify at least one checkpoint file exists
    const { readdirSync } = require("fs");
    const ckpts = readdirSync(result.ckptDir).filter(f => f.endsWith(".ckpt"));
    expect(ckpts.length).toBeGreaterThan(0);
  });
});
```

---

## 8. Python-side Changes

### `conftest.py` — Point to `examples/nntrees/`

```python
# Before
FIXTURES_DIR = Path(__file__).resolve().parent.parent.parent  # converted/

# After
FIXTURES_DIR = Path(__file__).resolve().parent.parent.parent.parent / "examples" / "nntrees"
```

### New: `src/tests/test_main.py` — Training smoke test (Python-side)

A lightweight pytest file that the npm orchestrator can also invoke directly:

```python
# test_main.py
import subprocess
import json
from pathlib import Path

def test_training_smoke(tmp_path, mninst_nntree_json):
    """main.py runs 1 epoch without errors."""
    # Write NNTree JSON
    json_path = tmp_path / "diagram.json"
    json_path.write_text(json.dumps(mninst_nntree_json))

    # Convert
    cfg_dir = tmp_path / "cfg"
    subprocess.run([
        "uv", "run", "python", "src/convert.py",
        str(json_path), str(cfg_dir), "--num-classes", "10"
    ], check=True)

    # Train
    result = subprocess.run([
        "uv", "run", "python", "src/main.py",
        "--config-dir", str(cfg_dir),
        "--config-name", "base",
        "trainer.max_epochs=1",
        "trainer.enable_progress_bar=false",
        "wandb.mode=disabled",
    ], capture_output=True, text=True, timeout=600)

    assert result.returncode == 0
```

### New: `src/tests/test_infer.py` — Inference test (Python-side)

```python
def test_inference_output(tmp_path, mninst_nntree_json):
    """infer.py produces valid predictions JSON."""
    # ... (convert + train 1 epoch + infer) ...
    output_json = tmp_path / "predictions.json"
    result = subprocess.run([
        "uv", "run", "python", "src/infer.py",
        "--config-path", str(cfg_dir),
        "--config-name", "base",
        "--weights", str(ckpt_path),
        "--output", str(output_json),
    ], check=True)

    predictions = json.loads(output_json.read_text())
    assert "predictions" in predictions
    assert len(predictions["predictions"]) > 0
```

---

## 9. Device Configuration (CPU vs GPU)

### How it works

The `NNM_DEVICE` env var controls the PyTorch accelerator via Hydra override:

```
NNM_DEVICE=cpu  → trainer.accelerator=cpu trainer.devices=1
NNM_DEVICE=gpu  → trainer.accelerator=gpu trainer.devices=auto
```

### Implementation in helper

```ts
function buildTrainOverrides(options: TrainOptions): string[] {
  const overrides: string[] = [];
  const device = options.device || process.env.NNM_DEVICE || "cpu";

  if (device === "gpu") {
    overrides.push("trainer.accelerator=gpu");
    overrides.push("trainer.devices=auto");
  } else {
    overrides.push("trainer.accelerator=cpu");
    overrides.push("trainer.devices=1");
  }

  return overrides;
}
```

### Default behavior

- **CPU always the default** (safe, works everywhere)
- GPU must be explicitly requested via `NNM_DEVICE=gpu`
- Tier 2 (forward pass) always runs on CPU (fast enough, no GPU contention)
- Tier 3/4 respect `NNM_DEVICE` setting

---

## 10. Future HTTP Integration

When the HTTP server (`converted/src/server.py`) is implemented, the integration framework can be extended with:

- **Tier 5: HTTP smoke** — POST `/train` with NNTree JSON, verify 202 response
- **Tier 6: Training status polling** — GET `/train/{job_id}`, verify progress updates
- **Tier 7: Inference via HTTP** — POST `/infer`, verify predictions returned

The same `NNM_DIAGRAM` and `NNM_DEVICE` env vars would apply.

---

## 11. CI/CD Integration (Future)

### Recommended: GitHub Actions matrix

```yaml
# .github/workflows/integration.yml (future)
name: Integration Tests
on: [push, pull_request]
jobs:
  smoke:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        diagram: [mninst, autoencoder_mnist, transformer_classifier, ...]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: pnpm install
      - run: NNM_DIAGRAM=${{ matrix.diagram }} pnpm test:integration:smoke

  train:
    runs-on: [self-hosted, gpu]
    steps:
      - run: NNM_DEVICE=gpu NNM_DIAGRAM=mninst pnpm test:integration:train
```

---

## 12. Implementation Plan

### Phase 1 — Examples consolidation (frontend + backend)

| Task | Agent | Files |
|------|-------|-------|
| Create `examples/diagrams/` and `examples/nntrees/` dirs | `@frontend` | New dirs |
| Move 10 root JSONs → `examples/diagrams/` | `@frontend` | `examples/diagrams/*.json` |
| Move 6 `converted/` JSONs → `examples/nntrees/` | `@backend` | `examples/nntrees/*.json` |
| Create `examples/manifest.json` with all 16 entries | `@frontend` | `examples/manifest.json` |
| Update `conftest.py` FIXTURES_DIR | `@backend` | `converted/src/tests/conftest.py` |
| Update `test_convert.py` and `test_integration.py` paths | `@backend` | `converted/src/tests/test_*.py` |
| Update `converted/README.md` paths | `@backend` | `converted/README.md` |
| Delete original JSONs from root and `converted/` | `@frontend` + `@backend` | `rm *.json`, `rm converted/*.json` |
| Run all existing tests to verify nothing broke | `@reviewer` | Review |

### Phase 2 — Integration test infrastructure

| Task | Agent | Files |
|------|-------|-------|
| Create `vitest.integration.config.ts` | `@frontend` | `front-end/vitest.integration.config.ts` |
| Create `src/__tests__/integration/helpers.ts` | `@frontend` | `front-end/src/__tests__/integration/helpers.ts` |
| Add npm scripts to `package.json` | `@frontend` | `front-end/package.json` |
| Create `smoke.test.ts` (Tier 0) | `@frontend` | `front-end/src/__tests__/integration/smoke.test.ts` |
| Create `convert.test.ts` (Tier 1) | `@frontend` | `front-end/src/__tests__/integration/convert.test.ts` |
| Create `forward.test.ts` (Tier 2) | `@frontend` | `front-end/src/__tests__/integration/forward.test.ts` |
| Create `train.test.ts` (Tier 3) | `@frontend` | `front-end/src/__tests__/integration/train.test.ts` |
| Create `infer.test.ts` (Tier 4) | `@frontend` | `front-end/src/__tests__/integration/infer.test.ts` |

### Phase 3 — Python-side training/inference tests

| Task | Agent | Files |
|------|-------|-------|
| Create `test_main.py` (training smoke) | `@backend` | `converted/src/tests/test_main.py` |
| Create `test_infer.py` (inference validation) | `@backend` | `converted/src/tests/test_infer.py` |
| Move `pytest` to dev-dependency in `pyproject.toml` | `@backend` | `converted/pyproject.toml` |

### Phase 4 — Validation & Cleanup

| Task | Agent | Files |
|------|-------|-------|
| Run full integration suite, fix issues | `@frontend` + `@backend` | Various |
| Review all changes | `@reviewer` | `docs/archive/reports/reviews/integration-testing-framework_approved.md` |
| Update `AGENTS.md` with new test structure | `@frontend` | `AGENTS.md` |

---

## 13. Success Criteria

- [ ] `pnpm test:integration:smoke` passes for all 10 Svelte Flow diagrams
- [ ] `pnpm test:integration:convert` passes for all 10 diagrams
- [ ] `pnpm test:integration:forward` passes for 5 key diagrams
- [ ] `pnpm test:integration:train` passes for 2 diagrams on CPU
- [ ] `NNM_DIAGRAM=mninst pnpm test:integration:all` runs the full pipeline for a single diagram
- [ ] `NNM_DEVICE=gpu pnpm test:integration:train` works on GPU
- [ ] All existing 179 tests still pass after examples/ migration
- [ ] Clean exit code 0 on success, non-zero on failure (CI-compatible)
