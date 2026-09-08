"""Contract tests for the package-native training worker."""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest
import torch
from torch.utils.data import DataLoader

from dataset.contracts import DatasetBatchContract, DatasetClassMetadata, DatasetDefinition, DatasetReference, TensorSlotContract, TrainingBatch
from package_runtime import PackageValidationError
from package_worker import (
    _dataset_loaders,
    _ClassificationAccumulator,
    _materialize_dataset_inputs,
    _normalized_training,
    _validate_graph_bindings,
    main,
    run,
    train,
)
from training.datasets import resolve_dataset

REFERENCE = DatasetReference(
    kind="project", id="demo.dataset", version="1.0.0",
    ref="dataset_aaaaaaaaaaaaaaaaaaaaaaaa", digest="a" * 64,
)
DEFINITION = DatasetDefinition(
    id="demo.dataset", version="1.0.0", name="Demo dataset",
    parameters=({"name": "B", "type": "integer", "required": True},),
    batch=DatasetBatchContract(
        inputs={"image": TensorSlotContract(shape=("B", 1), dtype="float32")},
        targets={"label": TensorSlotContract(shape=("B",), dtype="int64")},
    ),
)


def training_package() -> dict[str, object]:
    return {"graph": {
        "nodes": [{"id": "input", "type": "input"}],
        "inputBindings": [{"nodeId": "input", "name": "image", "contract": {"shape": ["B", 1], "dtype": "float32"}}],
        "objectiveBindings": [],
    }}


def test_project_dataset_loader_supports_dataclass_module_definitions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "dataset"
    root.mkdir()
    root.joinpath("dataset.json").write_text(json.dumps(DEFINITION.model_dump()), encoding="utf-8")
    root.joinpath("dataset.py").write_text(
        "from dataclasses import dataclass\n"
        "@dataclass(frozen=True)\n"
        "class Settings:\n"
        "    batch_size: int\n"
        "class Dataset:\n"
        "    def division(self): return {}\n"
        "def build(parameters, context): return Dataset()\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("NNM_DATASET_ROOT", str(root))
    dataset, definition, reference, parameters = resolve_dataset({
        "dataset": {"reference": REFERENCE.model_dump(), "parameters": {"B": 2}},
    })
    assert definition.id == REFERENCE.id
    assert reference == REFERENCE
    assert parameters == {"B": 2}
    assert dataset.division() == {}


def test_run_rejects_missing_package(tmp_path: Path) -> None:
    input_path = tmp_path / "job.json"
    input_path.write_text(json.dumps({"training": {}}), encoding="utf-8")
    with pytest.raises(ValueError, match="package is required"):
        run(input_path, tmp_path / "artifacts")


def test_training_contract_requires_opaque_dataset_reference() -> None:
    with pytest.raises(ValueError, match="reference is required"):
        _normalized_training({"dataset": {"target": "legacy.target"}})


def test_worker_accepts_frozen_wandb_modes_and_rejects_controller_fields() -> None:
    for mode in ("disabled", "offline", "online"):
        normalized = _normalized_training(
            {
                "dataset": {"reference": REFERENCE.model_dump(), "parameters": {}},
                "wandb": {"mode": mode, "project": "demo"},
            }
        )
        assert normalized["wandb"] == {"mode": mode, "project": "demo"}
    with pytest.raises(ValueError, match="only mode and project"):
        _normalized_training(
            {
                "dataset": {"reference": REFERENCE.model_dump(), "parameters": {}},
                "wandb": {"mode": "online", "project": "demo", "entity": "forbidden"},
            }
        )


def test_worker_reads_bounded_credentials_before_run_and_closes_stdin(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    payload = json.dumps(
        {
            "schema_version": 1,
            "api_key": "test-secret",
            "base_url": "https://wandb.example.test",
            "entity": "team",
        }
    ).encode("utf-8")
    stdin = io.TextIOWrapper(io.BytesIO(payload), encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_run(input_path: Path, artifacts_path: Path, *, wandb_credentials=None) -> dict[str, object]:
        captured["input_path"] = input_path
        captured["artifacts_path"] = artifacts_path
        captured["credentials"] = wandb_credentials
        return {"ok": True}

    monkeypatch.setattr("package_worker.run", fake_run)
    monkeypatch.setattr(sys, "stdin", stdin)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "package_worker",
            "--input",
            str(tmp_path / "input.json"),
            "--artifacts",
            str(tmp_path),
            "--wandb-credentials-stdin",
        ],
    )
    main()

    assert captured["credentials"].api_key == "test-secret"
    assert stdin.closed


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


def test_classification_worker_logs_metrics_and_final_test(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    definition = DEFINITION.model_copy(update={"classes": DatasetClassMetadata(count=2, names=("ham", "spam"))})
    batches = [TrainingBatch({"image": torch.tensor([[1.0], [-1.0]])}, {"label": torch.tensor([1, 0])})]

    class Dataset:
        def division(self):
            loader = DataLoader(batches, batch_size=None)
            return {"train": loader, "validation": loader, "test": loader}

    class Model(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.weight = torch.nn.Parameter(torch.ones(()))

        def objective(self, inputs, targets):
            return (inputs["image"].mean() * self.weight - targets["label"].float().mean()).square()

        def prediction(self, inputs):
            value = inputs["image"][:, 0] * self.weight
            return torch.stack((-value, value), dim=1)

    class Tracker:
        def __init__(self):
            self.epochs = []
            self.final = None
        def log_epoch(self, *args, **kwargs):
            self.epochs.append(kwargs)
        def finish(self, **kwargs):
            self.final = kwargs
        def abort(self):
            raise AssertionError("unexpected tracker abort")

    tracker = Tracker()
    monkeypatch.setattr("package_worker.resolve_dataset", lambda _training: (Dataset(), definition, REFERENCE, {}))
    monkeypatch.setattr("package_worker.create_tracker", lambda *args, **kwargs: tracker)
    summary = train(Model(), {"training": {"dataset": {"reference": REFERENCE.model_dump(), "parameters": {}}, "trainer": {"max_epochs": 1, "patience": 0}}, "package": training_package()}, tmp_path)

    assert tracker.epochs[0]["train_classification"]["accuracy"] == 1.0
    assert tracker.final["classification"]["labels"] == ["ham", "spam"]
    assert tracker.final["classification"]["confusion_matrix"] == [[1, 0], [0, 1]]
    assert summary["classification"]["training_seconds"] >= 0


def test_classification_worker_rejects_invalid_prediction_shape(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    definition = DEFINITION.model_copy(update={"classes": DatasetClassMetadata(count=2)})
    batch = TrainingBatch({"image": torch.ones(1, 1)}, {"label": torch.zeros(1, dtype=torch.long)})
    class Dataset:
        def division(self):
            loader = DataLoader([batch], batch_size=None)
            return {"train": loader, "validation": loader, "test": loader}
    class Model(torch.nn.Module):
        def objective(self, *_args):
            return torch.ones((), requires_grad=True)
        def prediction(self, _inputs):
            return torch.ones(1)
    monkeypatch.setattr("package_worker.resolve_dataset", lambda _training: (Dataset(), definition, REFERENCE, {}))
    with pytest.raises(ValueError, match="prediction must return logits"):
        train(Model(), {"training": {"dataset": {"reference": REFERENCE.model_dump(), "parameters": {}}, "trainer": {"max_epochs": 1}}, "package": training_package()}, tmp_path)


def test_multiclass_metrics_expose_only_macro_variants() -> None:
    accumulator = _ClassificationAccumulator(3)
    accumulator.add(torch.tensor([0, 1, 2]), torch.tensor([0, 2, 1]))
    metrics = accumulator.metrics(binary=False)
    assert set(metrics) == {"accuracy", "macro_precision", "macro_recall", "macro_f1"}


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
    package["graph"]["inputBindings"][0]["contract"]["shape"] = ["B", 2]

    with pytest.raises(ValueError, match="incompatible shape"):
        _validate_graph_bindings(package, DEFINITION)


def test_graph_bindings_reject_legacy_input_parameters_without_contract() -> None:
    package = training_package()
    package["graph"]["inputBindings"][0].pop("contract")
    package["graph"]["nodes"][0]["params"] = {"shape": ["B", 1], "dtype": "float32"}

    with pytest.raises(ValueError, match="missing a resolved tensor contract"):
        _validate_graph_bindings(package, DEFINITION)


def test_materialize_dataset_inputs_resolves_symbols_and_keeps_batch_dynamic() -> None:
    definition = DatasetDefinition(
        id="demo.dataset", version="1.0.0", name="Demo dataset",
        parameters=(
            {"name": "B", "type": "integer", "required": True},
            {"name": "features", "type": "integer", "required": True},
        ),
        batch=DatasetBatchContract(
            inputs={"image": TensorSlotContract(shape=("B", "features"), dtype="float32")},
            targets={"label": TensorSlotContract(shape=("B",), dtype="int64")},
        ),
    )
    package = {"graph": {
        "nodes": [{"id": "input", "type": "input"}],
        "inputBindings": [{"nodeId": "input", "name": "image"}],
        "edges": [],
    }}
    materialized = _materialize_dataset_inputs(package, definition, {"B": 32, "features": 4})
    assert materialized["graph"]["inputContracts"] == {
        "image": {"type": "tensor", "shape": ["B", 4], "dtype": "float32"},
    }
    assert materialized["graph"]["inputBindings"][0]["contract"] == materialized["graph"]["inputContracts"]["image"]


def test_graph_bindings_reject_incompatible_input_dtype() -> None:
    package = training_package()
    package["graph"]["inputBindings"][0]["contract"]["dtype"] = "int64"

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
            id="demo.dataset", version="1.0.0", name="Demo dataset",
            parameters=({"name": "B", "type": "integer", "required": True},),
            batch=DatasetBatchContract(
                inputs={"image": TensorSlotContract(shape=("B", 1), dtype="float32")},
                targets={"label": TensorSlotContract(shape=("B", 1, 2), dtype="int64")},
            ),
        ))
