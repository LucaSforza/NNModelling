"""Offline MNIST dataset builder for the ResNet classification example."""

from __future__ import annotations

from collections.abc import Mapping
import json
from pathlib import Path
from typing import Any

import torch
from torch.utils.data import DataLoader, Dataset, random_split


MEAN = 0.1307
STD = 0.3081
DEFAULT_NUM_WORKERS = 0
DEFAULT_TRAIN_SIZE = 0.1


def _validate_parameters(parameters: Mapping[str, object]) -> dict[str, object]:
    values = {
        "B": parameters.get("B"),
        "num_workers": parameters.get("num_workers", DEFAULT_NUM_WORKERS),
        "train_size": parameters.get("train_size", DEFAULT_TRAIN_SIZE),
    }
    if isinstance(values["B"], bool) or not isinstance(values["B"], int) or values["B"] < 1:
        raise ValueError("B must be a positive integer")
    if isinstance(values["num_workers"], bool) or not isinstance(values["num_workers"], int) or values["num_workers"] < 0:
        raise ValueError("num_workers must be a non-negative integer")
    if isinstance(values["train_size"], bool) or not isinstance(values["train_size"], (int, float)) or not 0 < values["train_size"] <= 1:
        raise ValueError("train_size must be greater than 0 and at most 1")
    values["train_size"] = float(values["train_size"])
    return values


def _read_jsonl(path: Path) -> tuple[torch.Tensor, torch.Tensor]:
    image_bytes = bytearray()
    labels: list[int] = []
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSON in {path.name} at line {line_number}") from exc
            if not isinstance(record, Mapping):
                raise TypeError(f"record in {path.name} at line {line_number} must be an object")

            image = record.get("image")
            if (
                not isinstance(image, list)
                or len(image) != 28 * 28
                or any(isinstance(pixel, bool) or not isinstance(pixel, int) or not 0 <= pixel <= 255 for pixel in image)
            ):
                raise ValueError(f"record in {path.name} at line {line_number} has an invalid 28x28 image")
            label = record.get("label")
            if isinstance(label, bool) or not isinstance(label, int) or not 0 <= label <= 9:
                raise ValueError(f"record in {path.name} at line {line_number} has an invalid label")
            image_bytes.extend(image)
            labels.append(label)

    if not image_bytes:
        raise ValueError(f"MNIST JSONL is empty: {path.name}")
    image_tensor = torch.frombuffer(image_bytes, dtype=torch.uint8).clone().reshape(-1, 28, 28)
    normalized = image_tensor.to(dtype=torch.float32).div_(255.0).sub_(MEAN).div_(STD).unsqueeze(1)
    return normalized, torch.tensor(labels, dtype=torch.int64)


class _ClassificationDataset(Dataset[dict[str, dict[str, torch.Tensor]]]):
    def __init__(self, images: torch.Tensor, labels: torch.Tensor) -> None:
        if images.shape[0] != labels.shape[0]:
            raise ValueError("MNIST image and label counts do not match")
        self.images = images
        self.labels = labels

    def __len__(self) -> int:
        return self.images.shape[0]

    def __getitem__(self, index: int) -> dict[str, dict[str, torch.Tensor]]:
        return {
            "inputs": {"image": self.images[index]},
            "targets": {"target": self.labels[index]},
        }


class ResNetMNIST:
    """MNIST train/validation/test splits with named classification batches."""

    def __init__(self, resource_root: Path, batch_size: int, num_workers: int, train_size: float) -> None:
        data_root = Path(resource_root) / "data"
        train_images, train_labels = _read_jsonl(data_root / "train.jsonl")
        test_images, test_labels = _read_jsonl(data_root / "test.jsonl")
        self.train_dataset = _ClassificationDataset(train_images, train_labels)
        self.test_dataset = _ClassificationDataset(test_images, test_labels)
        self.batch_size = batch_size
        self.num_workers = num_workers
        self.train_size = train_size

    def division(self) -> Mapping[str, DataLoader]:
        train_count = int(self.train_size * len(self.train_dataset))
        validation_count = len(self.train_dataset) - train_count
        train, validation = random_split(
            self.train_dataset,
            [train_count, validation_count],
            generator=torch.Generator().manual_seed(0),
        )
        common = {"batch_size": self.batch_size, "num_workers": self.num_workers}
        return {
            "train": DataLoader(train, shuffle=True, **common),
            "validation": DataLoader(validation, shuffle=False, **common),
            "test": DataLoader(self.test_dataset, shuffle=False, **common),
        }


def build(parameters: Mapping[str, object], context: Any) -> ResNetMNIST:
    """Build the dataset using only the supplied read-only resource root."""

    values = _validate_parameters(parameters)
    return ResNetMNIST(
        resource_root=Path(context.resource_root),
        batch_size=values["B"],
        num_workers=values["num_workers"],
        train_size=values["train_size"],
    )


validate_parameters = _validate_parameters
