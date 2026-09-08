"""Tests for package-worker W&B tracking."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
import wandb

from training.wandb_tracking import WandbTracker, create_tracker, normalize_wandb_config


class FakeRun:
    id = "run-123"
    url = "https://wandb.example.test/runs/run-123"

    def __init__(self) -> None:
        self.summary: dict[str, object] = {}
        self.logs: list[tuple[dict[str, float], int]] = []
        self.finish_count = 0
        self.finish_exit_codes: list[int | None] = []

    def log(self, values: dict[str, float], *, step: int) -> None:
        self.logs.append((values, step))

    def finish(self, *, exit_code: int | None = None) -> None:
        self.finish_count += 1
        self.finish_exit_codes.append(exit_code)


class FakeSettings:
    def __init__(self, **kwargs: object) -> None:
        self.values = kwargs


class FakeSdk:
    Settings = FakeSettings

    def __init__(self) -> None:
        self.kwargs: dict[str, object] | None = None
        self.init_environment: dict[str, str | None] | None = None
        self.run = FakeRun()

    def init(self, **kwargs: object) -> FakeRun:
        self.kwargs = kwargs
        self.init_environment = {
            "WANDB_API_KEY": os.environ.get("WANDB_API_KEY"),
            "WANDB_BASE_URL": os.environ.get("WANDB_BASE_URL"),
        }
        return self.run


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
    tracker.log_epoch(1, 1.5, 1.25)
    tracker.finish(best_loss=1.25, completed_epochs=1, num_parameters=7)

    assert sdk.run.logs == [({"train/loss": 1.5, "validation/loss": 1.25}, 1)]
    assert sdk.run.summary == {"best_loss": 1.25, "completed_epochs": 1, "num_parameters": 7}
    assert sdk.run.finish_count == 1
    assert sdk.run.finish_exit_codes == [None]
    assert "test-secret" not in (tmp_path / "wandb-run.json").read_text(encoding="utf-8")


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
