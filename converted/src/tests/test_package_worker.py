"""Contract tests for the package-native training worker."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import torch
from torch.utils.data import DataLoader

from dataset.contracts import DatasetBatchContract, DatasetDefinition, DatasetReference, TensorSlotContract, TrainingBatch
from package_runtime import PackageValidationError
from package_worker import _dataset_loaders, _normalized_training, _validate_graph_bindings, run, train

REFERENCE = DatasetReference(kind="builtin", id="builtin.mnist", version="1.0.0", ref="builtin_mnist")
DEFINITION = DatasetDefinition(
    id="builtin.mnist", version="1.0.0", name="MNIST",
    batch=DatasetBatchContract(
        inputs={"image": TensorSlotContract(shape=("B", 1), dtype="float32")},
        targets={"label": TensorSlotContract(shape=("B",), dtype="int64")},
    ),
)


def training_package() -> dict[str, object]:
    return {"graph": {
        "nodes": [{"id": "input", "params": {"shape": ["B", 1], "dtype": "float32"}}],
        "inputBindings": [{"nodeId": "input", "name": "image"}],
        "objectiveBindings": [],
    }}


def test_run_rejects_missing_package(tmp_path: Path) -> None:
    input_path = tmp_path / "job.json"
    input_path.write_text(json.dumps({"training": {}}), encoding="utf-8")
    with pytest.raises(ValueError, match="package is required"):
        run(input_path, tmp_path / "artifacts")


def test_training_contract_requires_opaque_dataset_reference() -> None:
    with pytest.raises(ValueError, match="reference is required"):
        _normalized_training({"dataset": {"target": "legacy.target"}})


def test_training_passes_named_batch_to_objective(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    batches = [TrainingBatch({"image": torch.ones(2, 1)}, {"label": torch.tensor([1, 0], dtype=torch.long)})]

    class RegisteredDataset:
        def division(self):
            loader = DataLoader(batches, batch_size=None)
            return {"train": loader, "validation": loader, "test": loader}

    class ObjectiveModel(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.weight = torch.nn.Parameter(torch.ones(()))
            self.targets: list[torch.Tensor] = []

        def objective(self, inputs, targets) -> torch.Tensor:
            self.targets.append(targets["label"].detach().clone())
            return ((inputs["image"].mean() * self.weight) - targets["label"].float().mean()).square()

    monkeypatch.setattr("package_worker.resolve_dataset", lambda _training: (RegisteredDataset(), DEFINITION, REFERENCE, {}))
    model = ObjectiveModel()
    train(model, {"training": {"dataset": {"reference": REFERENCE.model_dump(), "parameters": {}}, "trainer": {"max_epochs": 1, "patience": 0}}, "package": training_package()}, tmp_path)
    assert torch.equal(model.targets[0], torch.tensor([1, 0], dtype=torch.long))


def test_training_propagates_typed_missing_objective_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class RegisteredDataset:
        def division(self):
            loader = DataLoader([TrainingBatch({"image": torch.ones(1, 1)}, {"label": torch.zeros(1, dtype=torch.long)})], batch_size=None)
            return {"train": loader, "validation": loader, "test": loader}

    class NoObjectiveModel(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.weight = torch.nn.Parameter(torch.ones(()))

        def objective(self, _inputs, _targets) -> torch.Tensor:
            raise PackageValidationError("training requires an objective node")

    monkeypatch.setattr("package_worker.resolve_dataset", lambda _training: (RegisteredDataset(), DEFINITION, REFERENCE, {}))
    with pytest.raises(PackageValidationError, match="objective node"):
        train(NoObjectiveModel(), {"training": {"dataset": {"reference": REFERENCE.model_dump(), "parameters": {}}, "trainer": {"max_epochs": 1}}, "package": training_package()}, tmp_path)


def test_loader_settings_stay_inside_dataset_parameters() -> None:
    with pytest.raises(ValueError, match="belong in training.dataset.parameters"):
        _normalized_training({"dataset": {"reference": REFERENCE.model_dump(), "parameters": {}}, "batch_size": 7})
    normalized = _normalized_training({"dataset": {"reference": REFERENCE.model_dump(), "parameters": {"batch_size": 64}}, "trainer": {"max_epochs": 3, "patience": 2}})
    assert normalized["dataset"]["parameters"] == {"batch_size": 64}
    assert normalized["trainer"] == {"max_epochs": 3, "patience": 2, "accelerator": "auto", "min_delta": 0.0}


def test_dataset_loaders_reject_legacy_tuple_division() -> None:
    class LegacyDataset:
        def division(self):
            return ("train", "validation", "test")

    with pytest.raises(ValueError, match="exactly train, validation, and test"):
        _dataset_loaders(LegacyDataset())


def test_dataset_loaders_require_all_named_splits() -> None:
    class IncompleteDataset:
        def division(self):
            return {"train": "train", "validation": "validation"}

    with pytest.raises(ValueError, match="exactly train, validation, and test"):
        _dataset_loaders(IncompleteDataset())


def test_graph_bindings_reject_incompatible_input_shape() -> None:
    package = training_package()
    package["graph"]["nodes"][0]["params"]["shape"] = ["B", 2]

    with pytest.raises(ValueError, match="incompatible shape"):
        _validate_graph_bindings(package, DEFINITION)


def test_graph_bindings_reject_incompatible_input_dtype() -> None:
    package = training_package()
    package["graph"]["nodes"][0]["params"]["dtype"] = "int64"

    with pytest.raises(ValueError, match="incompatible dtype"):
        _validate_graph_bindings(package, DEFINITION)


def test_graph_bindings_compare_transformed_objective_target_contract() -> None:
    package = training_package()
    package["graph"]["objectiveBindings"] = [{
        "nodeId": "input",
        "externalInputs": [{
            "name": "target",
            "source": "batch.targets.label",
            "transform": "flatten_batch",
            "shape": ["B", 3],
            "dtype": "int64",
        }],
    }]

    with pytest.raises(ValueError, match="objective target 'label'.*incompatible shape"):
        _validate_graph_bindings(package, DatasetDefinition(
            id="builtin.mnist", version="1.0.0", name="MNIST",
            batch=DatasetBatchContract(
                inputs={"image": TensorSlotContract(shape=("B", 1), dtype="float32")},
                targets={"label": TensorSlotContract(shape=("B", 1, 2), dtype="int64")},
            ),
        ))
