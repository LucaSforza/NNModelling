"""Train the standalone PyTorch reproduction of ``transformer.spam``.

The model is independent from NNModelling at runtime. It mirrors the diagram
with native PyTorch modules and logs epoch metrics plus the final test report
to Weights & Biases.
"""

from __future__ import annotations

import argparse
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
import json
import os
from pathlib import Path
import random
import time
from typing import Any

import torch
from torch import nn
from torch.utils.data import DataLoader
import wandb

from dataset import DatasetContext, build


SEQUENCE_LENGTH = 128
MODEL_DIMENSION = 128
NUM_HEADS = 4
NUM_LAYERS = 2
FEED_FORWARD_DIMENSION = 512
NUM_CLASSES = 2
LABELS = ("ham", "spam")
CONFUSION_MATRIX_CONVENTION = "rows=actual, columns=predicted; labels=[ham, spam]"


class TransformerSpamClassifier(nn.Module):
    """Embedding + 2 Transformer blocks + mean token pool + binary classifier."""

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
        self.layers = nn.ModuleList([
            nn.TransformerEncoderLayer(
                d_model=MODEL_DIMENSION,
                nhead=NUM_HEADS,
                dim_feedforward=FEED_FORWARD_DIMENSION,
                dropout=0.0,
                activation="relu",
                batch_first=True,
                norm_first=False,
            )
            for _ in range(NUM_LAYERS)
        ])
        self.classifier = nn.Linear(MODEL_DIMENSION, NUM_CLASSES)

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        if features.ndim != 2 or features.shape[1] != SEQUENCE_LENGTH:
            raise ValueError(f"expected [batch, {SEQUENCE_LENGTH}], got {tuple(features.shape)}")
        hidden = self.embedding(features.long()) + self.position.unsqueeze(0)
        for layer in self.layers:
            hidden = layer(hidden)
        return self.classifier(hidden.mean(dim=1))


@dataclass(frozen=True)
class Metrics:
    loss: float
    accuracy: float
    precision: float
    recall: float
    f1: float
    specificity: float
    macro_precision: float
    macro_recall: float
    macro_f1: float
    confusion_matrix: list[list[int]]
    actual: list[int]
    predicted: list[int]
    count: int


def set_seed(seed: int) -> None:
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False


def _batches(
    loader: Iterable[Mapping[str, Mapping[str, torch.Tensor]]],
) -> Iterable[tuple[torch.Tensor, torch.Tensor]]:
    for batch in loader:
        features = batch["inputs"]["features"]
        labels = batch["targets"]["target"].argmax(dim=1)
        yield features, labels


def _safe_divide(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def _metrics(
    loss_total: float,
    count: int,
    matrix: list[list[int]],
    actual: list[int],
    predicted: list[int],
) -> Metrics:
    tn, fp = matrix[0]
    fn, tp = matrix[1]
    class_precision = [
        _safe_divide(tn, tn + fn),
        _safe_divide(tp, tp + fp),
    ]
    class_recall = [
        _safe_divide(tn, tn + fp),
        _safe_divide(tp, tp + fn),
    ]
    class_f1 = [
        _safe_divide(2 * class_precision[0] * class_recall[0], class_precision[0] + class_recall[0]),
        _safe_divide(2 * class_precision[1] * class_recall[1], class_precision[1] + class_recall[1]),
    ]
    return Metrics(
        loss=_safe_divide(loss_total, count),
        accuracy=_safe_divide(tn + tp, count),
        precision=class_precision[1],
        recall=class_recall[1],
        f1=class_f1[1],
        specificity=_safe_divide(tn, tn + fp),
        macro_precision=sum(class_precision) / 2,
        macro_recall=sum(class_recall) / 2,
        macro_f1=sum(class_f1) / 2,
        confusion_matrix=matrix,
        actual=actual,
        predicted=predicted,
        count=count,
    )


def _run_epoch(
    model: nn.Module,
    loader: DataLoader[Any],
    criterion: nn.Module,
    device: torch.device,
    optimizer: torch.optim.Optimizer | None = None,
) -> Metrics:
    training = optimizer is not None
    model.train(training)
    loss_total = 0.0
    count = 0
    matrix = [[0, 0], [0, 0]]
    actual: list[int] = []
    predicted: list[int] = []
    context = torch.enable_grad() if training else torch.no_grad()
    with context:
        for features, labels in _batches(loader):
            features, labels = features.to(device), labels.to(device)
            if training:
                optimizer.zero_grad(set_to_none=True)
            logits = model(features)
            loss = criterion(logits, labels)
            if training:
                loss.backward()
                optimizer.step()
            predictions = logits.argmax(dim=1)
            batch_count = labels.numel()
            loss_total += loss.item() * batch_count
            count += batch_count
            batch_actual = labels.detach().cpu().tolist()
            batch_predicted = predictions.detach().cpu().tolist()
            actual.extend(batch_actual)
            predicted.extend(batch_predicted)
            for expected, guess in zip(batch_actual, batch_predicted):
                matrix[expected][guess] += 1
    if not count:
        raise ValueError("the data split produced no complete batches; lower --batch-size")
    return _metrics(loss_total, count, matrix, actual, predicted)


def _metric_log(prefix: str, metrics: Metrics) -> dict[str, float]:
    return {
        f"{prefix}/loss": metrics.loss,
        f"{prefix}/accuracy": metrics.accuracy,
        f"{prefix}/precision": metrics.precision,
        f"{prefix}/recall": metrics.recall,
        f"{prefix}/f1": metrics.f1,
        f"{prefix}/specificity": metrics.specificity,
        f"{prefix}/macro_precision": metrics.macro_precision,
        f"{prefix}/macro_recall": metrics.macro_recall,
        f"{prefix}/macro_f1": metrics.macro_f1,
    }


def _default_dataset_root() -> Path:
    return Path(__file__).resolve().parents[2] / "diagrams/package/models/transformer.spam/datasets/spamham"


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def _positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-root", type=Path, default=_default_dataset_root())
    parser.add_argument("--epochs", type=_positive_int, default=5)
    parser.add_argument("--batch-size", type=_positive_int, default=32)
    parser.add_argument("--learning-rate", type=_positive_float, default=0.001)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--wandb-project", default=os.getenv("WANDB_PROJECT", "transformer-spam"))
    parser.add_argument("--wandb-entity", default=os.getenv("WANDB_ENTITY"))
    parser.add_argument("--wandb-run-name", default=None)
    parser.add_argument(
        "--wandb-mode",
        choices=("online", "offline", "disabled"),
        default=os.getenv("WANDB_MODE", "online"),
    )
    parser.add_argument("--json", action="store_true", help="print the final report as JSON")
    return parser.parse_args()


def _serializable_metrics(metrics: Metrics) -> dict[str, object]:
    return {
        "loss": metrics.loss,
        "accuracy": metrics.accuracy,
        "precision": metrics.precision,
        "recall": metrics.recall,
        "f1": metrics.f1,
        "specificity": metrics.specificity,
        "macro_precision": metrics.macro_precision,
        "macro_recall": metrics.macro_recall,
        "macro_f1": metrics.macro_f1,
        "confusion_matrix": metrics.confusion_matrix,
        "count": metrics.count,
    }


def train(args: argparse.Namespace) -> dict[str, object]:
    set_seed(args.seed)
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("--device cuda was requested but CUDA is unavailable")
    device = torch.device(
        "cuda"
        if args.device == "cuda" or (args.device == "auto" and torch.cuda.is_available())
        else "cpu"
    )
    project = build({"B": args.batch_size}, DatasetContext(args.dataset_root))
    divisions = project.division()
    model = TransformerSpamClassifier().to(device)
    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    run = None
    config = {
        "architecture": "transformer.spam",
        "sequence_length": SEQUENCE_LENGTH,
        "model_dimension": MODEL_DIMENSION,
        "num_heads": NUM_HEADS,
        "num_layers": NUM_LAYERS,
        "feed_forward_dimension": FEED_FORWARD_DIMENSION,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "learning_rate": args.learning_rate,
        "seed": args.seed,
        "device": str(device),
        "labels": list(LABELS),
    }
    if args.wandb_mode != "disabled":
        run = wandb.init(
            project=args.wandb_project,
            entity=args.wandb_entity,
            name=args.wandb_run_name,
            mode=args.wandb_mode,
            config=config,
        )

    started = time.perf_counter()
    last_train: Metrics | None = None
    last_validation: Metrics | None = None
    try:
        for epoch in range(1, args.epochs + 1):
            last_train = _run_epoch(model, divisions["train"], criterion, device, optimizer)
            last_validation = _run_epoch(model, divisions["validation"], criterion, device)
            epoch_log = {
                "epoch": epoch,
                **_metric_log("train", last_train),
                **_metric_log("validation", last_validation),
            }
            if run is not None:
                wandb.log(epoch_log)
            print(
                f"epoch {epoch:03d} | train loss {last_train.loss:.4f} | "
                f"val loss {last_validation.loss:.4f} | val accuracy {last_validation.accuracy:.4f}"
            )

        assert last_train is not None and last_validation is not None
        test = _run_epoch(model, divisions["test"], criterion, device)
        elapsed = time.perf_counter() - started
        final_log = {
            "test/loss": test.loss,
            "test/accuracy": test.accuracy,
            "test/precision": test.precision,
            "test/recall": test.recall,
            "test/f1": test.f1,
            "test/specificity": test.specificity,
            "test/macro_precision": test.macro_precision,
            "test/macro_recall": test.macro_recall,
            "test/macro_f1": test.macro_f1,
            "test/examples": test.count,
            "training/seconds": elapsed,
        }
        if run is not None:
            wandb.log({
                **final_log,
                "test/confusion_matrix": wandb.plot.confusion_matrix(
                    probs=None,
                    y_true=test.actual,
                    preds=test.predicted,
                    class_names=list(LABELS),
                ),
            })
            run.summary.update({
                **final_log,
                "test/confusion_matrix_values": test.confusion_matrix,
                "confusion_matrix_convention": CONFUSION_MATRIX_CONVENTION,
                "trainable_parameters": sum(p.numel() for p in model.parameters() if p.requires_grad),
            })
        result = {
            **config,
            "train": _serializable_metrics(last_train),
            "validation": _serializable_metrics(last_validation),
            "test": _serializable_metrics(test),
            "training_seconds": elapsed,
            "trainable_parameters": sum(p.numel() for p in model.parameters() if p.requires_grad),
            "confusion_matrix_convention": CONFUSION_MATRIX_CONVENTION,
        }
        if args.json:
            print(json.dumps(result, sort_keys=True))
        return result
    finally:
        if run is not None:
            wandb.finish()


def main() -> None:
    train(parse_args())


if __name__ == "__main__":
    main()
