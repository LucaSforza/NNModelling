"""Offline MNIST dataset builder for the ResNet classification example."""

from __future__ import annotations

from collections.abc import Mapping
import gzip
from pathlib import Path
import struct
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


def _read_idx_images(path: Path) -> torch.Tensor:
    with gzip.open(path, "rb") as archive:
        payload = archive.read()
    if len(payload) < 16:
        raise ValueError(f"invalid IDX image archive: {path.name}")
    magic, count, rows, columns = struct.unpack(">IIII", payload[:16])
    if magic != 2051 or rows != 28 or columns != 28:
        raise ValueError(f"unsupported IDX image archive: {path.name}")
    expected = count * rows * columns
    if len(payload) != 16 + expected:
        raise ValueError(f"truncated IDX image archive: {path.name}")
    raw = bytearray(payload[16:])
    images = torch.frombuffer(raw, dtype=torch.uint8).clone().reshape(count, rows, columns)
    return images.to(dtype=torch.float32).div_(255.0).sub_(MEAN).div_(STD).unsqueeze(1)


def _read_idx_labels(path: Path) -> torch.Tensor:
    with gzip.open(path, "rb") as archive:
        payload = archive.read()
    if len(payload) < 8:
        raise ValueError(f"invalid IDX label archive: {path.name}")
    magic, count = struct.unpack(">II", payload[:8])
    if magic != 2049:
        raise ValueError(f"unsupported IDX label archive: {path.name}")
    if len(payload) != 8 + count:
        raise ValueError(f"truncated IDX label archive: {path.name}")
    return torch.frombuffer(bytearray(payload[8:]), dtype=torch.uint8).clone().to(dtype=torch.int64)


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
        train_images = _read_idx_images(data_root / "train-images-idx3-ubyte.gz")
        train_labels = _read_idx_labels(data_root / "train-labels-idx1-ubyte.gz")
        test_images = _read_idx_images(data_root / "t10k-images-idx3-ubyte.gz")
        test_labels = _read_idx_labels(data_root / "t10k-labels-idx1-ubyte.gz")
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
