# NNModelling — Python Codegen Target

Converts NNTree JSON diagrams (exported from visual editor) into runnable PyTorch/Lightning models. Backend half of NNModelling DSL pipeline.

```
Diagram → NNTree JSON → convert.py → Hydra YAML configs → main.py → training
                                                         → infer.py  → inference
```

Observable analyses are a separate, passive interpretability path. They observe
forward values without becoming model layers, parameters, or weights:

```
NNTree interpretability → interpretability/observables.yaml → ObservableManager
                                                              → local/W&B results
```

## Setup

```bash
uv sync
```

Python 3.12+. Dependencies: torch, lightning, hydra-core, wandb, omegaconf, torchmetrics, transformers, datasets.

## Usage

### Generate Config

```bash
uv run python src/convert.py <json_path> <output_dir> [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `json_path` | (required) | Path to NNTree JSON (e.g. `../examples/nntrees/transformer_classifier.json`) |
| `output_dir` | `cfg` | Output directory for Hydra configs |
| `--num-classes N` | — | Required for classification tasks |
| `--dataset D` | `dataset.mnist.MNISTDataset` | Dataset class path |
| `--early-stop-patience N` | `3` | Early stopping patience |
| `--early-stop-min-delta F` | `0.0` | Early stopping min delta |
| `--max-epochs N` | `20` | Max training epochs |

**Output structure**:

```
cfg/
├── base.yaml                  # Root config composing all sub-configs
├── net/custom_sequence.yaml   # Network architecture (from NNTree JSON)
├── optimizer/adam.yaml        # Adam, lr=0.001
├── trainer/default.yaml       # max_epochs, accelerator
├── dataset/dataset.yaml       # Dataset class, batch_size, train/val split
├── wandb/wandb.yaml           # W&B project settings
├── interpretability/observables.yaml # Passive Observable definitions
└── early_stopping/default.yaml
```

``interpretability/observables.yaml`` is composed as its own Hydra group; its
definitions are not merged into ``net.nodes``. A source diagram without an
``interpretability`` section gets a disabled, no-op group.

### Train

```bash
uv run python src/main.py --config-path <dir> --config-name base
```

- Instantiates network dynamically from config via Hydra `instantiate()`
- Auto-detects classification (Accuracy) vs regression (MSE) from loss node `taskType`
- Logs to Weights & Biases (project: `NeuralNetworks`)
- Saves trained model to `weights.pt`
- Applies early stopping
- Finalizes enabled Observables and writes their results before model cleanup

### Interpretability and Observable results

The ``converted/src/interpretability/`` package contains the separate
``ObservableManager`` runtime and the passive ``ActivationRecorder`` and
``ActivationStatistics`` analyses. The manager owns hooks, temporary capture
state, lifecycle routing, and publication, but is not a ``torch.nn.Module``.
Hooks return ``None`` and captured values are detached by default, so enabling
an Observable does not replace an activation, change gradients, or alter the
model's ``state_dict``.

``ActivationRecorder`` samples forward tensors and stores large values as local
tensor artifacts. Its result rows contain references and metadata rather than
embedding large tensors in a table. ``ActivationStatistics`` updates streaming
count, mean, variance, norm, and sparsity without retaining all activations.
Each Observable instance owns a separate stable table/publication key when W&B
is available. W&B publication is best effort: if W&B is disabled, unavailable,
or a publication fails, the same result is retained in local JSON and tensor
artifacts.

Results are isolated below a run directory. The parent is taken from the
generated ``trainer.default_root_dir`` (and therefore is normally the remote
job artifact directory), or from ``NNM_INTERPRETABILITY_ROOT`` when no config
root is supplied. A fresh run ID is generated for each execution unless
``NNM_INTERPRETABILITY_RUN_ID`` or an explicit run ID is provided. Thus an
inference run does not append to training output when it is configured with its
own run ID/root. Cleanup removes hooks and transient in-memory state while
leaving the local result files in place.

Observable definitions and results are deliberately not included in exported
model weights or wheels. The exported model remains a portable inference
artifact, while interpretability output belongs to the originating run.

### Inference

```bash
uv run python src/infer.py --config-path <dir> --config-name base --weights <path> [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--weights` | `weights.pt` | Path to trained model weights |
| `--output` | — | Path to save predictions JSON |
| `--image-dir` | — | Directory for prediction visualizations (montage + per-sample strips) |
| `--device` | `cpu` | Device for inference |
| `--interpretability-root` | — | Stable parent directory for this inference run's Observable results |
| `--interpretability-run-id` | — | Optional externally assigned ID for this inference run |

Supports both classification (argmax labels) and autoencoder (image reconstruction) outputs.

## Examples

### Transformer Classifier (EnronSpam)

```bash
uv run python src/convert.py ../examples/nntrees/transformer_classifier.json cfg --num-classes 2 \
  --dataset dataset.enron_spam.EnronSpamDataset
uv run python src/main.py --config-path cfg --config-name base
```

Inference with an explicitly isolated Observable result location can use the
same Hydra config while keeping prediction data separate from training data:

```bash
uv run python src/infer.py --config-path cfg --config-name base --weights weights.pt \
  --output predictions.json \
  --interpretability-root ./runs/interpretability \
  --interpretability-run-id predict-001
```

### Autoencoder

```bash
uv run python src/convert.py ../examples/nntrees/auto_encoder.json cfg \
  --dataset dataset.autoencoder_mnist.AutoencoderMNIST --max-epochs 50
uv run python src/main.py --config-path cfg --config-name base
```

### Skip Connections with Repeat

```bash
uv run python src/convert.py ../examples/nntrees/skip_connections_with_repetition.json cfg --num-classes 10
uv run python src/main.py --config-path cfg --config-name base
```

## Pre-converted Diagrams (NNTree JSON)

Files in `../examples/nntrees/` directory, ready for `convert.py`:

| File | Description |
|------|-------------|
| `transformer_classifier.json` | BERT-style: Embedding → PositionalEncoding → Repeat(TransformerBlock×2) → SequencePool → Linear |
| `auto_encoder.json` | Encoder → bottleneck → skip connection → decoder |
| `auto_encoder_nested_submodels.json` | Autoencoder with nested subflow inside subflow |
| `skip_connections_with_repetition.json` | Two Repeat subflows ×10 with residual forks/joins |
| `mninst_skip.json` | MNIST with skip connections |

## Architecture

### `net/base.py` — Dynamic DAG Network

`Net(LightningModule)` builds `ModuleDict` from config at runtime. Forward pass uses BFS topological sort with in-degree tracking:

1. Start from root (Input) node
2. Track in-degree per node — join nodes wait for all parents
3. Join input ordering preserved from edge targetHandle (`"in-0"`, `"in-1"`) — critical for non-commutative ops (MatMul, ScaledDotProduct)
4. Subflow nodes delegate to `ops.Subflow` which runs its own BFS internally
5. Flatten is explicit via Flatten stereotype (no auto-flatten heuristic)

### `ops/` — Custom Operations

| Module | Description |
|--------|-------------|
| `Addition` | Element-wise sum of N tensors |
| `Concat` | `torch.cat(tensors, dim)` |
| `Einsum` | `torch.einsum(expr, tensors)` |
| `MatMul` | `inputs[0] @ inputs[1]` |
| `ScaledDotProduct` | Q·K^T·sqrt(1/d) for attention scores |
| `MaskedScaledDotProduct` | Same + causal upper-triangular -inf mask |
| `Subflow` | BFS DAG executor for internal graph (mini `Net`) |
| `Repeat` | N sequential Subflow copies with independent weights |
| `HorizontalRepeat` | N parallel Subflow copies via `vmap` + `functional_call`. Output `[batch, ..., n*d]`. Join hardcoded to concat on dim=-1. |
| `PositionalEncoding` | Sinusoidal sin/cos PE table (non-trainable buffer) |
| `SequencePool` | Mean pool over sequence dim: `[B, L, D] → [B, D]` |

### `dataset/` — Dataset Classes

| Class | Description |
|-------|-------------|
| `dataset.mnist.MNISTDataset` | Standard MNIST (28×28 images → digit labels) |
| `dataset.autoencoder_mnist.AutoencoderMNIST` | MNIST autoencoder (image → same image) |
| `dataset.enron_spam.EnronSpamDataset` | Text classification (spam/ham) via HF datasets + transformers tokenizer |
| `dataset.ds.Dataset` | Abstract base class |

### `infer.py` — Inference

Loads trained model, runs test set, optionally saves predictions as JSON (classification: argmax labels, regression: raw) and image montages (autoencoder: input|target|prediction strips).

## Testing

```bash
uv run pytest src/tests/ -v
```

| File | Coverage |
|------|----------|
| `test_convert.py` | `parse_params`, `build_layer_config`, subflow config, YAML generation with real JSONs |
| `test_ops.py` | All custom ops: forward pass, shapes, edge cases, input ordering |
| `test_base.py` | `Net` dispatch, BFS forward, in-degrees, join/subflow execution |
| `test_integration.py` | Full pipeline: JSON → convert → `Net.forward` using real fixtures |
| `test_main.py` | Training smoke tests (autoencoder + MNIST classifier) |
| `test_infer.py` | Inference validation (autoencoder + MNIST classifier) |
| `test_interpretability.py` | Separate Hydra group, source binding, lifecycle/mode gating, local/W&B fallback, run isolation, serialization cleanup |

The exact number of tests changes as the backend evolves; use pytest output as
the authoritative count. The interpretability tests exercise the passive
runtime without making W&B an external test dependency.

## Project Structure

```
converted/
├── src/
│   ├── convert.py                # NNTree JSON → Hydra YAML configs
│   ├── main.py                   # Training entry point (Hydra + Lightning)
│   ├── infer.py                  # Inference: load model, run test set, save predictions/images
│   ├── net/base.py               # Dynamic DAG LightningModule (BFS topo sort)
│   ├── interpretability/         # ObservableManager, passive analyses, and publishers
│   │   ├── __init__.py
│   │   ├── base.py
│   │   ├── manager.py
│   │   ├── publishers.py
│   │   ├── recorder.py            # ActivationRecorder
│   │   └── statistics.py          # ActivationStatistics
│   ├── ops/                      # 11 custom nn.Module operations
│   │   ├── addition.py
│   │   ├── concat.py
│   │   ├── einsum.py
│   │   ├── mat_mul.py
│   │   ├── scaled_dot_product.py
│   │   ├── masked_scaled_dot_product.py
│   │   ├── subflow.py
│   │   ├── repeat.py
│   │   ├── horizontal_repeat.py
│   │   ├── positional_encoding.py
│   │   └── sequence_pool.py
│   ├── dataset/
│   │   ├── ds.py                  # Abstract base
│   │   ├── mnist.py               # MNIST classification
│   │   ├── autoencoder_mnist.py   # MNIST autoencoder
│   │   └── enron_spam.py          # Text classification (spam/ham)
│   └── tests/
│       ├── conftest.py            # JSON fixture loaders
│       ├── test_convert.py        # Conversion and YAML tests
│       ├── test_ops.py            # Custom operation tests
│       ├── test_base.py           # Dynamic network tests
│       ├── test_integration.py    # End-to-end forward tests
│       ├── test_infer.py          # Inference validation
│       └── test_interpretability.py # Observable runtime and conversion tests
├── pyproject.toml                 # Dependencies
└── README.md
```
