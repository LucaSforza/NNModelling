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
import torch
from torch.utils.data import DataLoader

from abc import abstractmethod
from collections.abc import Mapping
from typing import Any

from dataset.contracts import DatasetContext, DatasetDefinition, TrainingBatch


class Dataset(torch.utils.data.Dataset):
    """Base class for trusted datasets built by the worker registry.

    Dataset metadata and construction are deliberately separate from this
    runtime class.  The backend registry publishes fixed descriptors and
    invokes a fixed builder; it never derives a public contract from a Python
    constructor signature.
    """

    @abstractmethod
    def division(self) -> tuple[DataLoader, DataLoader, DataLoader]:
        raise NotImplementedError("Dataset.division is not implemented by subclasses")

    @classmethod
    def num_classes(cls, config: dict[str, Any]) -> int | None:
        """Return the fixed classification cardinality, if this dataset has one.

        This metadata is intentionally available without constructing the
        dataset, which may otherwise download data or allocate worker state.
        """

        del config
        return None

    @classmethod
    def class_names(cls, config: dict[str, Any]) -> list[str] | None:
        """Return display names ordered by class index, when known."""

        del config
        return None

    @classmethod
    def definition(cls) -> DatasetDefinition:
        """Return the declarative definition owned by the dataset package."""

        raise NotImplementedError("Dataset.definition is not implemented by this dataset")

    @classmethod
    def build(cls, parameters: Mapping[str, object], context: DatasetContext) -> "Dataset":
        """Build a trusted dataset from already validated parameters."""

        del context
        return cls(**dict(parameters))


def named_batch(
    inputs: Mapping[str, torch.Tensor],
    targets: Mapping[str, torch.Tensor],
) -> TrainingBatch:
    """Create the only batch representation emitted by built-in loaders."""

    return TrainingBatch(inputs=dict(inputs), targets=dict(targets))

    @classmethod
    def inference_adapter_spec(cls, config: dict[str, Any]) -> dict[str, Any]:
        """Describe a portable inference adapter without constructing a dataset.

        The default accepts only model-ready tensors. Dataset implementations
        may override it with a declarative specification understood by the
        exported model wheel.
        """

        del config
        return {"kind": "tensor", "version": 1}
