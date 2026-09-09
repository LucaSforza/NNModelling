"""Tests for package-worker W&B tracking."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
import wandb
from PIL import Image

from training.wandb_tracking import WandbTracker, create_tracker, normalize_wandb_config


class FakeRun:
    id = "run-123"
    url = "https://wandb.example.test/runs/run-123"

    def __init__(self) -> None:
        self.summary: dict[str, object] = {}
        self.logs: list[tuple[dict[str, object], int]] = []
        self.log_environments: list[dict[str, str | None]] = []
        self.finish_count = 0
        self.finish_exit_codes: list[int | None] = []
        self.finish_environments: list[dict[str, str | None]] = []

    def log(self, values: dict[str, object], *, step: int | None = None) -> None:
        self.logs.append((values, step))
        self.log_environments.append(_wandb_storage_environment())

    def finish(self, *, exit_code: int | None = None) -> None:
        self.finish_count += 1
        self.finish_exit_codes.append(exit_code)
        self.finish_environments.append(_wandb_storage_environment())


class FakeSettings:
    def __init__(self, **kwargs: object) -> None:
        self.values = kwargs


class FakeSdk:
    Settings = FakeSettings

    def __init__(self) -> None:
        self.kwargs: dict[str, object] | None = None
        self.init_environment: dict[str, str | None] | None = None
        self.run = FakeRun()
    @staticmethod
    def Image(path: str, *, caption: str) -> dict[str, object]:
        return {"path": path, "caption": caption}

    def init(self, **kwargs: object) -> FakeRun:
        self.kwargs = kwargs
        self.init_environment = {
            "WANDB_API_KEY": os.environ.get("WANDB_API_KEY"),
            "WANDB_BASE_URL": os.environ.get("WANDB_BASE_URL"),
            **_wandb_storage_environment(),
        }
        return self.run


def _wandb_storage_environment() -> dict[str, str | None]:
    return {
        "WANDB_CACHE_DIR": os.environ.get("WANDB_CACHE_DIR"),
        "WANDB_DATA_DIR": os.environ.get("WANDB_DATA_DIR"),
    }


def test_normalize_wandb_config_is_closed_and_defaults_disabled() -> None:
    assert normalize_wandb_config(None) == {"mode": "disabled", "project": "NeuralNetworks"}
    assert normalize_wandb_config({"mode": "offline", "project": "demo"}) == {
        "mode": "offline",
        "project": "demo",
    }


def test_tracker_records_metrics_and_writes_structured_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("WANDB_API_KEY", raising=False)
    monkeypatch.delenv("WANDB_BASE_URL", raising=False)
    sdk = FakeSdk()
    tracker = WandbTracker(
        mode="online",
        project="demo",
        run_name="nnm-job-1",
        artifacts_path=tmp_path,
        config={"wandb": {"mode": "online", "project": "demo"}},
        credentials={
            "schema_version": 1,
            "api_key": "test-secret",
            "base_url": "https://wandb.example.test",
            "entity": "team",
        },
        sdk=sdk,
    )
    assert sdk.kwargs is not None
    assert sdk.kwargs["name"] == "nnm-job-1"
    assert sdk.kwargs["mode"] == "online"
    assert sdk.kwargs["force"] is True
    settings = sdk.kwargs["settings"]
    assert isinstance(settings, FakeSettings)
    assert settings.values["api_key"] == "test-secret"
    assert settings.values["base_url"] == "https://wandb.example.test"
    assert settings.values["root_dir"] == str(tmp_path)
    assert settings.values["x_files_dir"] == str(tmp_path / "wandb")
    assert sdk.init_environment == {
        "WANDB_API_KEY": "test-secret",
        "WANDB_BASE_URL": "https://wandb.example.test",
        "WANDB_CACHE_DIR": str(tmp_path / "wandb" / "cache"),
        "WANDB_DATA_DIR": str(tmp_path / "wandb" / "data"),
    }
    assert "WANDB_API_KEY" not in os.environ
    assert "WANDB_BASE_URL" not in os.environ
    manifest = json.loads((tmp_path / "wandb-run.json").read_text(encoding="utf-8"))
    assert manifest == {
        "mode": "online",
        "id": "run-123",
        "entity": "team",
        "project": "demo",
        "url": "https://wandb.example.test/runs/run-123",
    }
    tracker.log_step_loss("train", 10, 0.75)
    tracker.log_epoch(1, 1.5, 1.25, epoch_seconds=3.5)
    tracker.finish(best_loss=1.25, completed_epochs=1, num_parameters=7)

    assert sdk.run.logs == [
        ({"train/step": 10, "train/step_loss": 0.75}, None),
        (
            {
                "epoch": 1,
                "train/loss": 1.5,
                "validation/loss": 1.25,
                "epoch/seconds": 3.5,
            },
            None,
        ),
    ]
    assert sdk.run.summary == {"best_loss": 1.25, "completed_epochs": 1, "num_parameters": 7}
    assert sdk.run.finish_count == 1
    assert sdk.run.finish_exit_codes == [None]
    assert "test-secret" not in (tmp_path / "wandb-run.json").read_text(encoding="utf-8")


def test_tracker_confines_wandb_storage_environment_to_job_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("WANDB_CACHE_DIR", "/outside/cache")
    monkeypatch.setenv("WANDB_DATA_DIR", "/outside/data")
    sdk = FakeSdk()
    tracker = WandbTracker(
        mode="offline",
        project="offline-test",
        run_name="nnm-job-offline",
        artifacts_path=tmp_path,
        config={},
        sdk=sdk,
    )
    tracker.log_epoch(1, 1.0, 0.5)
    tracker.finish(best_loss=0.5, completed_epochs=1, num_parameters=3)

    expected = {
        "WANDB_CACHE_DIR": str(tmp_path / "wandb" / "cache"),
        "WANDB_DATA_DIR": str(tmp_path / "wandb" / "data"),
    }
    assert sdk.init_environment is not None
    assert {name: sdk.init_environment[name] for name in expected} == expected
    assert sdk.run.log_environments == [expected]
    assert sdk.run.finish_environments == [expected]
    assert _wandb_storage_environment() == {
        "WANDB_CACHE_DIR": "/outside/cache",
        "WANDB_DATA_DIR": "/outside/data",
    }


def test_disabled_tracker_does_not_import_or_initialize_sdk(tmp_path: Path) -> None:
    tracker = create_tracker(
        {"wandb": {"mode": "disabled", "project": "demo"}},
        {"id": "job-1"},
        tmp_path,
        sdk=object(),
    )
    tracker.log_epoch(1, 1.0, 1.0)
    tracker.finish(best_loss=1.0, completed_epochs=1, num_parameters=1)
    assert not (tmp_path / "wandb-run.json").exists()


def test_offline_tracker_rejects_online_credentials(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="offline W&B tracking"):
        WandbTracker(
            mode="offline",
            project="offline-test",
            run_name="nnm-job-offline",
            artifacts_path=tmp_path,
            config={"wandb": {"mode": "offline", "project": "offline-test"}},
            credentials={
                "schema_version": 1,
                "api_key": "test-secret",
                "base_url": "https://wandb.example.test",
                "entity": "team",
            },
            sdk=FakeSdk(),
        )


def test_real_offline_tracker_writes_a_wandb_run_file_without_credentials(tmp_path: Path) -> None:
    tracker = create_tracker(
        {"wandb": {"mode": "offline", "project": "offline-test"}, "seed": 1},
        {"id": "job-offline"},
        tmp_path,
        sdk=wandb,
    )
    tracker.log_epoch(1, 2.0, 1.0)
    tracker.finish(best_loss=1.0, completed_epochs=1, num_parameters=3)
    assert list((tmp_path / "wandb").rglob("*.wandb"))
    manifest = json.loads((tmp_path / "wandb-run.json").read_text(encoding="utf-8"))
    assert manifest["mode"] == "offline"
    assert manifest["url"] is None


def test_real_offline_confusion_matrix_works_with_read_only_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    read_only_parent = tmp_path / "read-only"
    read_only_parent.mkdir(mode=0o500)
    monkeypatch.setenv("HOME", str(read_only_parent / "home"))
    artifacts_path = tmp_path / "artifacts"
    metrics = {
        "accuracy": 1.0,
        "precision": 1.0,
        "recall": 1.0,
        "f1": 1.0,
        "specificity": 1.0,
        "macro_precision": 1.0,
        "macro_recall": 1.0,
        "macro_f1": 1.0,
    }
    try:
        tracker = create_tracker(
            {"wandb": {"mode": "offline", "project": "offline-test"}},
            {"id": "job-offline-classification"},
            artifacts_path,
            sdk=wandb,
        )
        tracker.finish(
            best_loss=0.1,
            completed_epochs=1,
            num_parameters=3,
            classification={
                "loss": 0.1,
                **metrics,
                "count": 2,
                "labels": ["ham", "spam"],
                "actual": [0, 1],
                "predicted": [0, 1],
                "confusion_matrix": [[1, 0], [0, 1]],
                "binary": True,
            },
        )
    finally:
        read_only_parent.chmod(0o700)

    assert list((artifacts_path / "wandb").rglob("*.wandb"))


def test_abort_marks_failed_finish_when_sdk_supports_exit_code(tmp_path: Path) -> None:
    sdk = FakeSdk()
    tracker = WandbTracker(
        mode="offline",
        project="offline-test",
        run_name="nnm-job-offline",
        artifacts_path=tmp_path,
        config={"wandb": {"mode": "offline", "project": "offline-test"}},
        sdk=sdk,
    )
    tracker.abort()
    assert sdk.run.finish_exit_codes == [1]


def test_classification_metrics_and_confusion_matrix_are_logged(tmp_path: Path) -> None:
    sdk = FakeSdk()
    tracker = WandbTracker(
        mode="offline",
        project="demo",
        run_name="nnm-job-classification",
        artifacts_path=tmp_path,
        config={"wandb": {"mode": "offline", "project": "demo"}},
        sdk=sdk,
    )
    metrics = {
        "accuracy": 0.8,
        "precision": 0.75,
        "recall": 0.6,
        "f1": 0.6667,
        "specificity": 1.0,
        "macro_precision": 0.875,
        "macro_recall": 0.8,
        "macro_f1": 0.8333,
    }
    tracker.log_epoch(
        1,
        0.5,
        0.4,
        epoch_seconds=0.75,
        train_classification=metrics,
        validation_classification=metrics,
    )
    tracker.finish(
        best_loss=0.4,
        completed_epochs=1,
        num_parameters=7,
        training_seconds=12.5,
        classification={
            "loss": 0.3,
            **metrics,
            "count": 4,
            "labels": ["ham", "spam"],
            "actual": [0, 1, 1, 0],
            "predicted": [0, 1, 0, 0],
            "confusion_matrix": [[2, 0], [1, 1]],
            "binary": True,
        },
    )
    epoch_log = sdk.run.logs[0][0]
    assert epoch_log["train/accuracy"] == 0.8
    assert epoch_log["epoch/seconds"] == 0.75
    final_log = sdk.run.logs[1][0]
    assert final_log["test/examples"] == 4
    assert final_log["training/seconds"] == 12.5
    confusion_image = final_log["test/confusion_matrix"]
    assert confusion_image == {
        "path": str(tmp_path / "wandb" / "confusion-matrix.png"),
        "caption": "Confusion matrix — rows: actual, columns: predicted",
    }
    with Image.open(confusion_image["path"]) as image:
        assert image.format == "PNG"
        assert image.width >= 640
        assert image.height >= 640
    assert sdk.run.summary["test/confusion_matrix_values"] == [[2, 0], [1, 1]]
    assert sdk.run.summary["confusion_matrix_labels"] == ["ham", "spam"]


def test_classification_rejects_non_finite_metric(tmp_path: Path) -> None:
    tracker = WandbTracker(
        mode="offline",
        project="demo",
        run_name="nnm-job-classification",
        artifacts_path=tmp_path,
        config={},
        sdk=FakeSdk(),
    )
    with pytest.raises(ValueError, match="finite number"):
        metrics = {
            "accuracy": float("nan"),
            "precision": 0.5,
            "recall": 0.5,
            "f1": 0.5,
            "specificity": 0.5,
            "macro_precision": 0.5,
            "macro_recall": 0.5,
            "macro_f1": 0.5,
        }
        tracker.log_epoch(
            1,
            1.0,
            1.0,
            train_classification=metrics,
        )


def test_multiclass_logs_only_macro_metrics(tmp_path: Path) -> None:
    sdk = FakeSdk()
    tracker = WandbTracker(
        mode="offline",
        project="demo",
        run_name="nnm-job-multiclass",
        artifacts_path=tmp_path,
        config={},
        sdk=sdk,
    )
    metrics = {
        "accuracy": 0.75,
        "macro_precision": 0.7,
        "macro_recall": 0.72,
        "macro_f1": 0.71,
    }
    tracker.log_epoch(
        1,
        0.5,
        0.4,
        train_classification=metrics,
        validation_classification=metrics,
        binary_classification=False,
    )
    assert set(sdk.run.logs[0][0]) == {
        "epoch",
        "train/loss",
        "validation/loss",
        "train/accuracy",
        "train/macro_precision",
        "train/macro_recall",
        "train/macro_f1",
        "validation/accuracy",
        "validation/macro_precision",
        "validation/macro_recall",
        "validation/macro_f1",
    }
    tracker.finish(
        best_loss=0.4,
        completed_epochs=1,
        num_parameters=3,
        classification={
            "loss": 0.3,
            **metrics,
            "count": 3,
            "labels": ["a", "b", "c"],
            "actual": [0, 1, 2],
            "predicted": [0, 2, 2],
            "confusion_matrix": [[1, 0, 0], [0, 0, 1], [0, 0, 1]],
            "binary": False,
        },
        training_seconds=1.0,
    )
    assert set(sdk.run.logs[1][0]) == {
        "test/loss",
        "test/accuracy",
        "test/macro_precision",
        "test/macro_recall",
        "test/macro_f1",
        "test/examples",
        "training/seconds",
        "test/confusion_matrix",
    }
