"""Regression coverage for the built-in declarative dataset registry."""

from __future__ import annotations

import pytest
import torch

from backend.dataset_registry import (
    build_dataset,
    discover_datasets,
    resolve_dataset,
    validate_dataset_parameters,
)
from dataset.contracts import DatasetContext, TrainingBatch
from dataset.enron_spam import EnronSpamDataset


def test_catalog_uses_one_opaque_descriptor_shape_for_all_builtins() -> None:
    catalog = discover_datasets()
    assert {item.reference.id for item in catalog} == {
        "builtin.mnist",
        "builtin.enron-spam",
    }
    for item in catalog:
        wire = item.model_dump(mode="json")
        assert set(wire) == {"reference", "manifest", "definition"}
        assert "target" not in wire
        assert "target" not in wire["reference"]
        assert wire["reference"]["kind"] == "builtin"
        assert wire["definition"]["schemaVersion"] == 1


def test_descriptor_parameters_are_validated_without_constructor_introspection() -> None:
    mnist = next(item for item in discover_datasets() if item.reference.id == "builtin.mnist")
    assert validate_dataset_parameters(mnist.reference, {}) == {
        "batch_size": 32,
        "num_workers": 0,
        "train_size": 0.8,
    }
    assert validate_dataset_parameters(mnist.reference, {"batch_size": "64"}) == {
        "batch_size": 64,
        "num_workers": 0,
        "train_size": 0.8,
    }
    for item in discover_datasets():
        expected = {
            parameter.name: parameter.default
            for parameter in item.definition.parameters
            if parameter.default is not None
        }
        assert validate_dataset_parameters(item.reference, {}) == expected

    with pytest.raises(ValueError, match="unknown dataset parameter"):
        validate_dataset_parameters(mnist.reference, {"root": "/tmp"})
    with pytest.raises(ValueError, match="positive integer"):
        validate_dataset_parameters(mnist.reference, {"batch_size": 0})
    with pytest.raises(ValueError, match="at most 1"):
        validate_dataset_parameters(mnist.reference, {"train_size": 1.5})


def test_builders_resolve_only_exact_opaque_builtin_references() -> None:
    mnist = next(item for item in discover_datasets() if item.reference.id == "builtin.mnist")
    assert resolve_dataset(mnist.reference).builder is not None
    with pytest.raises(ValueError, match="not registered"):
        resolve_dataset(mnist.reference.model_copy(update={"ref": "dataset.mnist.MNISTDataset"}))


def test_mnist_and_autoencoder_loaders_emit_named_training_batches(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    class TinyMNIST(torch.utils.data.Dataset):
        def __init__(self, *, train, **_kwargs):
            self.samples = [
                (torch.full((1, 28, 28), float(index)), index % 10)
                for index in range(4 if train else 2)
            ]

        def __getitem__(self, index):
            return self.samples[index]

        def __len__(self):
            return len(self.samples)

    monkeypatch.setattr("dataset.mnist.datasets.MNIST", TinyMNIST)
    context = DatasetContext(resource_root=tmp_path)

    mnist = build_dataset(
        next(item.reference for item in discover_datasets() if item.reference.id == "builtin.mnist"),
        {"batch_size": 2, "train_size": 0.5},
        context,
    )
    mnist_splits = mnist.division()
    assert set(mnist_splits) == {"train", "validation", "test"}
    batch = next(iter(mnist_splits["train"]))
    assert isinstance(batch, TrainingBatch)
    assert set(batch.inputs) == {"image"}
    assert set(batch.targets) == {"label"}
    assert batch.inputs["image"].shape == (2, 1, 28, 28)

def test_enron_collator_emits_named_training_batch() -> None:
    dataset = object.__new__(EnronSpamDataset)
    dataset.collator = lambda _batch: {
        "input_ids": torch.tensor([[11, 12]], dtype=torch.int64),
        "attention_mask": torch.tensor([[1, 1]], dtype=torch.int64),
        "labels": torch.tensor([1], dtype=torch.int64),
    }
    batch = dataset._collate([{"input_ids": [11, 12], "attention_mask": [1, 1], "labels": 1}])
    assert isinstance(batch, TrainingBatch)
    assert set(batch.inputs) == {"input_ids", "attention_mask"}
    assert set(batch.targets) == {"label"}
    assert batch.targets["label"].dtype == torch.int64


def test_enron_division_returns_named_loaders() -> None:
    dataset = object.__new__(EnronSpamDataset)
    dataset.batch_size = 1
    dataset.train_size = 0.5
    dataset.num_workers = 0
    dataset.train_dataset = [{"input_ids": [1], "attention_mask": [1], "labels": 0}] * 2
    dataset.test_dataset = [{"input_ids": [2], "attention_mask": [1], "labels": 1}]
    dataset.collator = lambda batch: {
        "input_ids": torch.tensor([item["input_ids"] for item in batch]),
        "attention_mask": torch.tensor([item["attention_mask"] for item in batch]),
        "labels": torch.tensor([item["labels"] for item in batch]),
    }

    splits = dataset.division()

    assert set(splits) == {"train", "validation", "test"}
