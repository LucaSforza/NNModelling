"""Contract tests for the package-native training worker."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import torch
from torch.utils.data import DataLoader, TensorDataset

from package_runtime import PackageValidationError
from package_worker import _normalized_training, run, train


def test_run_rejects_missing_package(tmp_path: Path) -> None:
    input_path = tmp_path / "job.json"
    input_path.write_text(json.dumps({"training": {}}), encoding="utf-8")

    with pytest.raises(ValueError, match="package is required"):
        run(input_path, tmp_path / "artifacts")


def test_training_rejects_free_form_overrides() -> None:
    with pytest.raises(ValueError, match="overrides is not part"):
        _normalized_training(
            {
                "dataset": {"target": "dataset.mnist.MNISTDataset"},
                "overrides": ["trainer.max_epochs=9"],
            }
        )


def test_training_passes_explicit_batch_targets_to_objective(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    batches = [
        (torch.ones(2, 1), torch.tensor([1, 0], dtype=torch.long)),
    ]
    created: list[dict[str, object]] = []

    class RegisteredDataset:
        def __init__(self, **parameters: object) -> None:
            self.parameters = parameters
            created.append(parameters)

        def division(self):
            loader = DataLoader(TensorDataset(*batches[0]), batch_size=2)
            return loader, loader, loader

    class ObjectiveModel(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.weight = torch.nn.Parameter(torch.ones(()))
            self.targets: list[torch.Tensor] = []

        def objective(self, inputs: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
            self.targets.append(targets.detach().clone())
            return ((inputs.mean() * self.weight) - targets.float().mean()).square()

        def prediction(self, _inputs: torch.Tensor) -> torch.Tensor:
            raise AssertionError("training must not use the prediction program")

    model = ObjectiveModel()
    monkeypatch.setattr("package_worker._load_dataset_class", lambda _target: RegisteredDataset)
    train(
        model,  # type: ignore[arg-type]
        {
            "training": {
                "dataset": {
                    "target": "dataset.mnist.MNISTDataset",
                    "parameters": {"batch_size": 64, "num_workers": 0, "train_size": 0.05},
                },
                "trainer": {"max_epochs": 1, "patience": 0},
            }
        },
        tmp_path,
    )

    assert model.targets
    assert torch.equal(model.targets[0], torch.tensor([1, 0], dtype=torch.long))
    assert created == [{"batch_size": 64, "num_workers": 0, "train_size": 0.05}]


def test_training_propagates_typed_missing_objective_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class RegisteredDataset:
        def __init__(self, **_parameters: object) -> None:
            pass

        def division(self):
            loader = DataLoader(TensorDataset(torch.ones(1, 1), torch.zeros(1, dtype=torch.long)))
            return loader, loader, loader

    class NoObjectiveModel(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.weight = torch.nn.Parameter(torch.ones(()))

        def objective(self, _inputs: torch.Tensor, _targets: torch.Tensor) -> torch.Tensor:
            raise PackageValidationError("training requires an objective node")

    monkeypatch.setattr("package_worker._load_dataset_class", lambda _target: RegisteredDataset)
    with pytest.raises(PackageValidationError, match="objective node"):
        train(
            NoObjectiveModel(),  # type: ignore[arg-type]
            {"training": {"dataset": {"target": "dataset.mnist.MNISTDataset"}, "trainer": {"max_epochs": 1}}},
            tmp_path,
        )


def test_loader_settings_must_be_dataset_parameters() -> None:
    with pytest.raises(ValueError, match="belong in training.dataset.parameters"):
        _normalized_training(
            {
                "dataset": {"target": "dataset.mnist.MNISTDataset", "parameters": {}},
                "batch_size": 7,
            }
        )

    normalized = _normalized_training(
        {
            "dataset": {
                "target": "dataset.mnist.MNISTDataset",
                "parameters": {"batch_size": 64, "num_workers": 0, "train_size": 0.05},
            },
            "trainer": {"max_epochs": 3, "patience": 2},
        }
    )

    assert normalized["dataset"]["parameters"] == {"batch_size": 64, "num_workers": 0, "train_size": 0.05}
    assert normalized["trainer"] == {
        "max_epochs": 3,
        "patience": 2,
        "accelerator": "auto",
        "min_delta": 0.0,
    }
