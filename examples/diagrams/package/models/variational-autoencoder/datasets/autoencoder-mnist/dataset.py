"""Offline MNIST dataset builder for the variational-autoencoder example."""

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
DEFAULT_BATCH_SIZE = 32
DEFAULT_NUM_WORKERS = 0
DEFAULT_TRAIN_SIZE = 0.8


def _validate_parameters(parameters: Mapping[str, object]) -> dict[str, object]:
    values = {
        "batch_size": parameters.get("batch_size", DEFAULT_BATCH_SIZE),
        "num_workers": parameters.get("num_workers", DEFAULT_NUM_WORKERS),
        "train_size": parameters.get("train_size", DEFAULT_TRAIN_SIZE),
    }
    if isinstance(values["batch_size"], bool) or not isinstance(values["batch_size"], int) or values["batch_size"] < 1:
        raise ValueError("batch_size must be a positive integer")
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


class _ImageDataset(Dataset[dict[str, dict[str, torch.Tensor]]]):
    def __init__(self, images: torch.Tensor) -> None:
        self.images = images

    def __len__(self) -> int:
        return self.images.shape[0]

    def __getitem__(self, index: int) -> dict[str, dict[str, torch.Tensor]]:
        image = self.images[index]
        return {"inputs": {"image": image}, "targets": {"target": image}}


class AutoencoderMNIST(Dataset[dict[str, dict[str, torch.Tensor]]]):
    """MNIST train/validation/test splits with named autoencoder batches."""

    def __init__(self, resource_root: Path, batch_size: int, num_workers: int, train_size: float) -> None:
        data_root = Path(resource_root) / "data"
        self.train_dataset = _ImageDataset(_read_idx_images(data_root / "train-images-idx3-ubyte.gz"))
        self.test_dataset = _ImageDataset(_read_idx_images(data_root / "t10k-images-idx3-ubyte.gz"))
        self.batch_size = batch_size
        self.num_workers = num_workers
        self.train_size = train_size

    def __len__(self) -> int:
        return len(self.train_dataset)

    def __getitem__(self, index: int) -> dict[str, dict[str, torch.Tensor]]:
        return self.train_dataset[index]

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


def build(parameters: Mapping[str, object], context: Any) -> AutoencoderMNIST:
    """Build the dataset using only the supplied read-only resource root."""

    values = _validate_parameters(parameters)
    return AutoencoderMNIST(
        resource_root=Path(context.resource_root),
        batch_size=values["batch_size"],
        num_workers=values["num_workers"],
        train_size=values["train_size"],
    )


validate_parameters = _validate_parameters
