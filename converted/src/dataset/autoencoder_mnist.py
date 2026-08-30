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
from collections.abc import Mapping
import torch
from torch.utils.data import DataLoader, random_split
from typing import Any

from dataset.contracts import (
    DatasetBatchContract,
    DatasetContext,
    DatasetDefinition,
    DatasetSourceManifest,
    TensorSlotContract,
)
from dataset.mnist import MNISTDataset, validate_parameters as validate_mnist_parameters
from dataset.ds import named_batch


AUTOENCODER_MNIST_DATASET_ID = "builtin.autoencoder-mnist"
AUTOENCODER_MNIST_DATASET_VERSION = "1.0.0"
AUTOENCODER_MNIST_DATASET_REF = "builtin_autoencoder_mnist"
AUTOENCODER_MNIST_MANIFEST = DatasetSourceManifest(
    schemaVersion=1,
    id=AUTOENCODER_MNIST_DATASET_ID,
    version=AUTOENCODER_MNIST_DATASET_VERSION,
    entrypoints={"definition": "dataset.json", "python": "dataset.py"},
)
AUTOENCODER_MNIST_DEFINITION = DatasetDefinition(
    schemaVersion=1,
    id=AUTOENCODER_MNIST_DATASET_ID,
    version=AUTOENCODER_MNIST_DATASET_VERSION,
    name="Autoencoder MNIST",
    description="MNIST images paired with themselves for reconstruction.",
    parameters=MNISTDataset.definition().parameters,
    batch=DatasetBatchContract(
        inputs={"image": TensorSlotContract(shape=("B", 1, 28, 28), dtype="float32")},
        targets={"reconstruction": TensorSlotContract(shape=("B", 1, 28, 28), dtype="float32")},
    ),
    classes=None,
    inferenceAdapter=MNISTDataset.inference_adapter_spec({}),
)


class _ImageOnly:
    """Wraps MNIST dataset to return (image, image) for autoencoder."""

    def __init__(self, ds):
        self.ds = ds
    def __getitem__(self, idx):
        img, _ = self.ds[idx]
        return img, img
    def __len__(self):
        return len(self.ds)


class AutoencoderMNIST(MNISTDataset):
    """MNIST dataset for autoencoder training. Returns (image, image) instead of (image, label)."""

    @classmethod
    def definition(cls) -> DatasetDefinition:
        return AUTOENCODER_MNIST_DEFINITION

    @classmethod
    def num_classes(cls, config: dict[str, Any]) -> None:
        """Report no classification cardinality for reconstruction training."""

        del config
        return None

    @classmethod
    def class_names(cls, config: dict[str, Any]) -> None:
        """Report no class labels for reconstruction training."""

        del config
        return None

    def __getitem__(self, index):
        image, _ = self.dataset[index]
        return image, image

    def division(self) -> tuple[DataLoader, DataLoader, DataLoader]:
        train_size = int(self.train_size * len(self))
        val_size = len(self) - train_size
        train_dataset, val_dataset = random_split(self, [train_size, val_size])

        train_loader = DataLoader(train_dataset, batch_size=self.batch_size, shuffle=True, num_workers=self.num_workers, collate_fn=self._collate)
        val_loader = DataLoader(val_dataset, batch_size=self.batch_size, shuffle=False, num_workers=self.num_workers, collate_fn=self._collate)
        test_loader = DataLoader(_ImageOnly(self.test_dataset), batch_size=self.batch_size, shuffle=False, num_workers=self.num_workers, collate_fn=self._collate)

        return train_loader, val_loader, test_loader

    @staticmethod
    def _collate(batch: list[tuple[Any, Any]]) -> object:
        images, targets = zip(*batch)
        return named_batch(
            {"image": torch.stack(tuple(images))},
            {"reconstruction": torch.stack(tuple(targets))},
        )


def build(parameters: Mapping[str, object], context: DatasetContext) -> AutoencoderMNIST:
    """Fixed builder for reconstruction training."""

    values = validate_mnist_parameters(parameters)
    return AutoencoderMNIST(**values, _resource_root=context.resource_root)


validate_parameters = validate_mnist_parameters
