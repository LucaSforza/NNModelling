# NNModelling — DSL for designing neural networks via visual node editor
# Copyright (C) 2026  Luca Sforza
#
# Licensed under the GNU General Public License v3 or later.
# Commercial licenses are available — contact Luca Sforza.
# See the LICENSE file for details.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
from pathlib import Path
from collections.abc import Mapping
from typing import Any
import os
import torch
from torchvision import datasets, transforms
from torch.utils.data import DataLoader, random_split

from dataset.contracts import (
    DatasetBatchContract,
    DatasetContext,
    DatasetDefinition,
    DatasetParameter,
    DatasetClassMetadata,
    DatasetSourceManifest,
    TensorSlotContract,
)
from dataset.ds import Dataset, DatasetSplits, named_batch


MNIST_DATASET_ID = "builtin.mnist"
MNIST_DATASET_VERSION = "1.0.0"
MNIST_DATASET_REF = "builtin_mnist"
MNIST_MANIFEST = DatasetSourceManifest(
    schemaVersion=1,
    id=MNIST_DATASET_ID,
    version=MNIST_DATASET_VERSION,
    entrypoints={"definition": "dataset.json", "python": "dataset.py"},
)
MNIST_DEFINITION = DatasetDefinition(
    schemaVersion=1,
    id=MNIST_DATASET_ID,
    version=MNIST_DATASET_VERSION,
    name="MNIST",
    description="Ten-class handwritten digit classification dataset.",
    parameters=(
        DatasetParameter(name="batch_size", type="integer", default=32),
        DatasetParameter(name="num_workers", type="integer", default=0),
        DatasetParameter(name="train_size", type="number", default=0.8),
    ),
    batch=DatasetBatchContract(
        inputs={"image": TensorSlotContract(shape=("B", 1, 28, 28), dtype="float32")},
        targets={"label": TensorSlotContract(shape=("B",), dtype="int64")},
    ),
    classes=DatasetClassMetadata(count=10, names=tuple(str(index) for index in range(10))),
    inferenceAdapter={
        "kind": "image",
        "version": 1,
        "channels": 1,
        "size": [28, 28],
        "mean": [0.1307],
        "std": [0.3081],
    },
)


class MNISTDataset(Dataset):
    """Trusted MNIST runtime whose public metadata lives in ``MNIST_DEFINITION``."""

    @classmethod
    def definition(cls) -> DatasetDefinition:
        return MNIST_DEFINITION

    @classmethod
    def num_classes(cls, config: dict[str, Any]) -> int:
        """Return the ten digit classes supplied by MNIST."""

        del config
        return 10

    @classmethod
    def class_names(cls, config: dict[str, Any]) -> list[str]:
        """Return display names for the MNIST digit classes."""

        del config
        return [str(index) for index in range(10)]

    @classmethod
    def inference_adapter_spec(cls, config: dict[str, Any]) -> dict[str, Any]:
        """Export the image preprocessing used by MNIST training."""

        del config
        return {
            "kind": "image",
            "version": 1,
            "channels": 1,
            "size": [28, 28],
            "mean": [0.1307],
            "std": [0.3081],
        }

    def __init__(
        self,
        batch_size: int = 32,
        num_workers: int = 0,
        train_size: float = 0.8,
        *,
        _resource_root: Path | None = None,
    ) -> None:
        super().__init__()

        self.transform = transforms.Compose(
            [transforms.ToTensor(), transforms.Normalize((0.1307,), (0.3081,))]
        )
        # Load the MNIST dataset
        # Dataset storage is selected by the operator/container mount, never
        # by a browser-supplied path.
        dataset_root = _resource_root or Path(os.environ.get("NNM_DATASET_ROOT", "data"))
        self.dataset = datasets.MNIST(
            root=str(dataset_root), train=True, download=False, transform=self.transform
        )
        self.test_dataset = datasets.MNIST(
            root=str(dataset_root), train=False, download=False, transform=self.transform
        )

        self.train_size: float = train_size
        self.num_workers: int = num_workers
        self.batch_size: int = batch_size

    def __getitem__(self, index):
        return self.dataset[index]

    def __len__(self):
        return len(self.dataset)

    def division(self) -> DatasetSplits:
        # Split the dataset into training and validation sets
        train_size = int(self.train_size * len(self.dataset))
        val_size = len(self) - train_size
        train_dataset, val_dataset = random_split(self.dataset, [train_size, val_size])

        # Create DataLoaders for training, validation, and test sets
        train_loader = DataLoader(
            train_dataset,
            batch_size=self.batch_size,
            shuffle=True,
            num_workers=self.num_workers,
            collate_fn=self._collate,
        )
        val_loader = DataLoader(
            val_dataset,
            batch_size=self.batch_size,
            shuffle=False,
            num_workers=self.num_workers,
            collate_fn=self._collate,
        )
        test_loader = DataLoader(
            self.test_dataset,
            batch_size=self.batch_size,
            shuffle=False,
            num_workers=self.num_workers,
            collate_fn=self._collate,
        )
        return {
            "train": train_loader,
            "validation": val_loader,
            "test": test_loader,
        }

    @staticmethod
    def _collate(batch: list[tuple[torch.Tensor, int]]) -> object:
        images, labels = zip(*batch)
        return named_batch(
            {"image": torch.stack(tuple(images))},
            {"label": torch.as_tensor(labels, dtype=torch.int64)},
        )


def validate_parameters(parameters: Mapping[str, object]) -> dict[str, object]:
    """Validate MNIST's fixed primitive parameter contract."""

    result = dict(parameters)
    batch_size = result.get("batch_size", 32)
    num_workers = result.get("num_workers", 0)
    train_size = result.get("train_size", 0.8)
    if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size < 1:
        raise ValueError("batch_size must be a positive integer")
    if isinstance(num_workers, bool) or not isinstance(num_workers, int) or num_workers < 0:
        raise ValueError("num_workers must be a non-negative integer")
    if isinstance(train_size, bool) or not isinstance(train_size, (int, float)) or not 0 < train_size <= 1:
        raise ValueError("train_size must be greater than 0 and at most 1")
    if "train_size" in result:
        result["train_size"] = float(train_size)
    return result


def build(parameters: Mapping[str, object], context: DatasetContext) -> MNISTDataset:
    """Fixed builder used by the built-in registry and isolated worker."""

    values = validate_parameters(parameters)
    return MNISTDataset(**values, _resource_root=context.resource_root)
