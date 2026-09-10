# Standalone PyTorch `transformer.spam`

This directory is independent from NNModelling at runtime. It reimplements the
`transformer.spam` graph with native PyTorch modules:

- vocabulary-limited embedding `128 -> 128` and sinusoidal positional encoding;
- two Transformer encoder blocks, four attention heads, feed-forward `128 ->
  512 -> 128`;
- mean token pooling and a `128 -> 2` classifier trained with cross entropy.

The dataset adapter is a standalone copy of the SpamHam adapter. It expects the
prepared local files `data/train.jsonl` and `data/test.jsonl` below the
NNModelling dataset directory. The default path points there automatically;
use `--dataset-root` for another copy.

Install/lock the project with uv:

```bash
uv sync
```

For W&B cloud logging, authenticate first with `wandb login`, then run:

```bash
uv run python main.py --epochs 5 --wandb-project transformer-spam
```

Each epoch logs train and validation loss, accuracy, precision, recall, F1,
specificity and macro metrics. The final test pass logs the same metrics, test
loss and a W&B confusion-matrix panel. The test split is evaluated only after
training finishes.

For a local run without cloud access:

```bash
WANDB_MODE=offline uv run python main.py --epochs 1 --wandb-mode offline
```
