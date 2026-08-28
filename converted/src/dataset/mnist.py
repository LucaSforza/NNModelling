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
from typing import Any
import os
import torch
import torch.nn as nn
from torchvision import datasets, transforms
from torch.utils.data import DataLoader, random_split

from dataset.ds import Dataset


class MNISTDataset(Dataset):
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

    def __init__(self, batch_size=32, num_workers=0, train_size=0.8, root: str | None = None) -> None:
        super().__init__()

        self.transform = transforms.Compose(
            [transforms.ToTensor(), transforms.Normalize((0.1307,), (0.3081,))]
        )
        # Load the MNIST dataset
        dataset_root = Path(root or os.environ.get("NNM_DATASET_ROOT", "data"))
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

    def division(self) -> tuple[DataLoader, DataLoader, DataLoader]:
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
        )
        val_loader = DataLoader(
            val_dataset,
            batch_size=self.batch_size,
            shuffle=False,
            num_workers=self.num_workers,
        )
        test_loader = DataLoader(
            self.test_dataset,
            batch_size=self.batch_size,
            shuffle=False,
            num_workers=self.num_workers,
        )
        return train_loader, val_loader, test_loader
