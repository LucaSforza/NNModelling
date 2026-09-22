"""Editable project dataset scaffold for Project dataset.

The .pt files mentioned below are only a convenient starting point. Replace
the loader with any local, deterministic implementation that returns the
named TrainingBatch contract; project data must stay below context.resource_root.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch
from torch.utils.data import DataLoader, Dataset


@dataclass(frozen=True)
class DatasetContext:
    """Read-only resources supplied by the isolated dataset worker."""

    resource_root: Path
    # The worker supplies the opaque shared-contract reference as the second
    # positional field; keep its concrete backend type out of this scaffold.
    reference: Any | None = None


@dataclass(frozen=True)
class TrainingBatch:
    """Flat named tensor maps consumed by the compiled model."""

    inputs: Mapping[str, torch.Tensor]
    targets: Mapping[str, torch.Tensor]


class NamedTensorDataset(Dataset[TrainingBatch]):
    def __init__(self, batches: Sequence[TrainingBatch]) -> None:
        self._batches = list(batches)

    def __len__(self) -> int:
        return len(self._batches)

    def __getitem__(self, index: int) -> TrainingBatch:
        return self._batches[index]


def _load_pt_split(path: Path) -> NamedTensorDataset:
    """Load an optional split of named maps; edit this for another format."""
    if not path.is_file():
        raise FileNotFoundError(f"missing optional split file: {path.name}")
    raw: Any = torch.load(path, map_location="cpu", weights_only=False)
    if isinstance(raw, Mapping) and "inputs" in raw and "targets" in raw:
        raw = [raw]
    if not isinstance(raw, Sequence):
        raise TypeError("a .pt split must contain a sequence of named batches")
    batches: list[TrainingBatch] = []
    for item in raw:
        if not isinstance(item, Mapping) or not isinstance(item.get("inputs"), Mapping) or not isinstance(item.get("targets"), Mapping):
            raise TypeError("each split item must contain flat inputs and targets maps")
        if not all(isinstance(value, torch.Tensor) for value in item["inputs"].values()) or not all(isinstance(value, torch.Tensor) for value in item["targets"].values()):
            raise TypeError("split values must be tensors")
        batches.append(TrainingBatch(inputs=dict(item["inputs"]), targets=dict(item["targets"])))
    return NamedTensorDataset(batches)


class ProjectDataset:
    def __init__(self, splits: Mapping[str, DataLoader[TrainingBatch]]) -> None:
        self._splits = dict(splits)

    def division(self) -> Mapping[str, DataLoader[TrainingBatch]]:
        """Return train, validation and test loaders for the worker."""
        return self._splits


def build(parameters: Mapping[str, object], context: DatasetContext) -> ProjectDataset:
    """Build this dataset without importing project code in the API process."""
    del parameters
    data_root = context.resource_root / "data"
    # Optional editable starting files: data/train.pt, data/validation.pt and data/test.pt.
    split_files = {name: data_root / f"{name}.pt" for name in ("train", "validation", "test")}
    splits = {
        name: DataLoader(_load_pt_split(path), batch_size=None)
        for name, path in split_files.items()
    }
    return ProjectDataset(splits)

# Declared input slots: features
# Declared target slots: labels
