"""Offline MNIST dataset builder for the variational-autoencoder example."""

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
DEFAULT_TRAIN_SIZE = 0.8


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


def _read_jsonl_images(path: Path) -> torch.Tensor:
    image_bytes = bytearray()
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
            image_bytes.extend(image)

    if not image_bytes:
        raise ValueError(f"MNIST JSONL is empty: {path.name}")
    image_tensor = torch.frombuffer(image_bytes, dtype=torch.uint8).clone().reshape(-1, 28, 28)
    return image_tensor.to(dtype=torch.float32).div_(255.0).sub_(MEAN).div_(STD).unsqueeze(1)


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
        self.train_dataset = _ImageDataset(_read_jsonl_images(data_root / "train.jsonl"))
        self.test_dataset = _ImageDataset(_read_jsonl_images(data_root / "test.jsonl"))
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
        batch_size=values["B"],
        num_workers=values["num_workers"],
        train_size=values["train_size"],
    )


validate_parameters = _validate_parameters
