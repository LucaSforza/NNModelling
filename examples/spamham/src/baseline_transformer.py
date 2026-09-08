"""Train a small PyTorch baseline matching the ``transformer.spam`` graph.

The CLI reuses the project's SpamHam dataset adapter.  Prepare the ignored
Enron files under ``datasets/spamham/data`` first, then run, for example:

    uv run python src/baseline_transformer.py --dataset-root \
      ../diagrams/package/models/transformer.spam/datasets/spamham \
      --epochs 5 --batch-size 32 --json

The output is deliberately self-contained so it can be compared with an MCP
training job without relying on W&B or a particular accelerator.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import random
import sys
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader


SEQUENCE_LENGTH = 128
MODEL_DIMENSION = 128
NUM_CLASSES = 2
LABELS = ("ham", "spam")
CONFUSION_MATRIX_CONVENTION = "rows=actual, columns=predicted; labels=[ham, spam]"


class TransformerSpamClassifier(nn.Module):
    """Architecture represented by ``examples/.../transformer.spam/model.json``."""

    def __init__(self) -> None:
        super().__init__()
        self.embedding = nn.Embedding(128, MODEL_DIMENSION, dtype=torch.float32)
        position = torch.arange(SEQUENCE_LENGTH, dtype=torch.float32).unsqueeze(1)
        divisor = torch.exp(
            torch.arange(0, MODEL_DIMENSION, 2, dtype=torch.float32)
            * (-torch.log(torch.tensor(10000.0)) / MODEL_DIMENSION)
        )
        positional_encoding = torch.zeros(SEQUENCE_LENGTH, MODEL_DIMENSION)
        positional_encoding[:, 0::2] = torch.sin(position * divisor)
        positional_encoding[:, 1::2] = torch.cos(position * divisor)
        self.register_buffer("position", positional_encoding)
        self.layers = nn.ModuleList(
            [
                nn.TransformerEncoderLayer(
                    d_model=MODEL_DIMENSION,
                    nhead=4,
                    dim_feedforward=512,
                    dropout=0.0,
                    activation="relu",
                    batch_first=True,
                    norm_first=False,
                )
                for _ in range(2)
            ]
        )
        self.classifier = nn.Linear(MODEL_DIMENSION, NUM_CLASSES)

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        """Return logits for integer token IDs shaped ``[batch, 128]``."""

        if features.ndim != 2 or features.shape[1] != SEQUENCE_LENGTH:
            raise ValueError(f"expected [batch, {SEQUENCE_LENGTH}], got {tuple(features.shape)}")
        hidden = self.embedding(features.long()) + self.position.unsqueeze(0)
        for layer in self.layers:
            hidden = layer(hidden)
        return self.classifier(hidden.mean(dim=1))


def set_seed(seed: int) -> None:
    """Seed Python, NumPy and PyTorch for repeatable runs."""

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False


def load_dataset_adapter(path: Path) -> Any:
    """Load the checked-in adapter without duplicating its implementation."""

    spec = importlib.util.spec_from_file_location("spamham_dataset", path / "dataset.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load dataset adapter: {path / 'dataset.py'}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _batches(loader: Iterable[dict[str, dict[str, torch.Tensor]]]) -> Iterable[tuple[torch.Tensor, torch.Tensor]]:
    for batch in loader:
        features = batch["inputs"]["features"]
        targets = batch["targets"]["target"].argmax(dim=1)
        yield features, targets


@torch.no_grad()
def evaluate(model: nn.Module, loader: DataLoader[Any], device: torch.device) -> tuple[float, float, list[list[int]], int]:
    """Return loss, accuracy, binary confusion matrix and example count."""

    model.eval()
    criterion = nn.CrossEntropyLoss()
    total_loss = 0.0
    total = 0
    correct = 0
    matrix = [[0, 0], [0, 0]]
    for features, target in _batches(loader):
        logits = model(features.to(device))
        target = target.to(device)
        total_loss += criterion(logits, target).item() * target.numel()
        predictions = logits.argmax(dim=1)
        correct += int((predictions == target).sum())
        total += target.numel()
        for expected, predicted in zip(target.cpu().tolist(), predictions.cpu().tolist()):
            matrix[expected][predicted] += 1
    return total_loss / total, correct / total, matrix, total


def train(args: argparse.Namespace) -> dict[str, object]:
    """Train and evaluate the baseline, returning JSON-serializable metrics."""

    set_seed(args.seed)
    device = torch.device(args.device or ("cuda" if torch.cuda.is_available() else "cpu"))
    dataset = load_dataset_adapter(args.dataset_root)
    project = dataset.build({"B": args.batch_size}, dataset.DatasetContext(args.dataset_root))
    divisions = project.division()
    model = TransformerSpamClassifier().to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    criterion = nn.CrossEntropyLoss()
    train_examples = len(divisions["train"].dataset)
    processed_train_examples = 0
    started = time.perf_counter()
    train_loss = validation_loss = 0.0
    for _epoch in range(args.epochs):
        model.train()
        seen = 0
        train_loss = 0.0
        for features, target in _batches(divisions["train"]):
            features, target = features.to(device), target.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(model(features), target)
            loss.backward()
            optimizer.step()
            train_loss += loss.item() * target.numel()
            seen += target.numel()
            processed_train_examples += target.numel()
        train_loss /= seen
        validation_loss, _accuracy, _matrix, _count = evaluate(model, divisions["validation"], device)
    training_seconds = time.perf_counter() - started
    evaluation_started = time.perf_counter()
    final_validation_loss, _, _, validation_examples = evaluate(
        model, divisions["validation"], device
    )
    test_loss, accuracy, matrix, examples = evaluate(model, divisions["test"], device)
    evaluation_seconds = time.perf_counter() - evaluation_started
    parameters = sum(parameter.numel() for parameter in model.parameters() if parameter.requires_grad)
    return {
        "accuracy": accuracy,
        "confusion_matrix": matrix,
        "confusion_matrix_labels": list(LABELS),
        "confusion_matrix_convention": CONFUSION_MATRIX_CONVENTION,
        "train_loss": train_loss,
        "validation_loss": final_validation_loss,
        "test_loss": test_loss,
        "trainable_parameters": parameters,
        "seed": args.seed,
        "device": str(device),
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "examples": examples,
        "validation_examples": validation_examples,
        "train_examples": train_examples,
        "processed_train_examples": processed_train_examples,
        "throughput_examples_per_second": processed_train_examples / training_seconds if training_seconds else 0.0,
        "training_seconds": training_seconds,
        "evaluation_seconds": evaluation_seconds,
        "total_seconds": training_seconds + evaluation_seconds,
    }


def parse_args() -> argparse.Namespace:
    """Parse command-line options."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--epochs", type=_positive_int, default=5)
    parser.add_argument("--batch-size", type=_positive_int, default=32)
    parser.add_argument("--learning-rate", type=_positive_float, default=0.001)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--device", choices=("cpu", "cuda"), default=None)
    parser.add_argument("--json", action="store_true", help="emit metrics as one JSON object")
    return parser.parse_args()


def _positive_int(value: str) -> int:
    """Parse a strictly positive integer CLI value."""

    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def _positive_float(value: str) -> float:
    """Parse a strictly positive floating-point CLI value."""

    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def main() -> None:
    """Run the baseline and print comparison metrics."""

    args = parse_args()
    metrics = train(args)
    if args.json:
        print(json.dumps(metrics, sort_keys=True))
        return
    print(f"accuracy: {metrics['accuracy']:.4f}")
    print(f"confusion matrix ({metrics['confusion_matrix_convention']}): {metrics['confusion_matrix']}")
    print(f"training seconds: {metrics['training_seconds']:.2f}")
    for key in ("train_loss", "validation_loss", "trainable_parameters", "seed", "device", "epochs", "batch_size", "examples", "throughput_examples_per_second"):
        print(f"{key}: {metrics[key]}")


if __name__ == "__main__":
    main()
