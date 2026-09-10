"""Typed request-contract regressions for the package-native backend."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.models import BackendCapabilities, JobStatus, JobSubmission, WandbRun


def _training() -> dict[str, object]:
    return {
        "dataset": {
            "reference": {
                "kind": "project",
                "id": "demo.dataset",
                "version": "1.0.0",
                "ref": "dataset_aaaaaaaaaaaaaaaaaaaaaaaa",
                "digest": "a" * 64,
            },
        },
    }


def test_project_dataset_parameters_remain_opaque_until_owned_archive_resolution() -> None:
    submission = JobSubmission(
        network={"format": "package", "value": {"graph": {}, "bundle_ref": "bundle-1"}},
        training={
            **_training(),
            "dataset": {
                "reference": {
                    "kind": "project", "id": "demo.dataset",
                    "version": "1.0.0", "ref": "dataset_aaaaaaaaaaaaaaaaaaaaaaaa", "digest": "a" * 64,
                },
                "parameters": {"batch_size": "64", "num_workers": "0", "train_size": "0.05"},
            },
        },
    )

    assert submission.training.dataset.parameters == {"batch_size": "64", "num_workers": "0", "train_size": "0.05"}

    opaque = JobSubmission(
        network={"format": "package", "value": {"graph": {}, "bundle_ref": "bundle-1"}},
        training={**_training(), "dataset": {**_training()["dataset"], "parameters": {"root": "/tmp"}}},
    )
    assert opaque.training.dataset.parameters == {"root": "/tmp"}


def test_job_submission_accepts_only_package_network_format() -> None:
    """The public submission model has no NNTree compatibility path."""
    package = JobSubmission(
        network={
            "format": "package",
            "value": {"graph": {"nodes": [], "edges": []}, "bundle_ref": "bundle-1"},
        },
        training=_training(),
    )

    assert package.network.format == "package"
    assert "overrides" not in package.training.model_dump()
    assert package.training.trainer.log_every_n_steps == 10

    configured = JobSubmission(
        network={
            "format": "package",
            "value": {"graph": {}, "bundle_ref": "bundle-1"},
        },
        training={**_training(), "trainer": {"log_every_n_steps": 7}},
    )
    assert configured.training.trainer.log_every_n_steps == 7

    with pytest.raises(ValidationError, match="log_every_n_steps"):
        JobSubmission(
            network={
                "format": "package",
                "value": {"graph": {}, "bundle_ref": "bundle-1"},
            },
            training={**_training(), "trainer": {"log_every_n_steps": 0}},
        )

    with pytest.raises(ValidationError, match="reference"):
        JobSubmission(
            network={
                "format": "package",
                "value": {"graph": {"nodes": [], "edges": []}, "bundle_ref": "bundle-1"},
            },
            training={"dataset": {"target": "dataset.legacy.Dataset"}},
        )

    with pytest.raises(ValidationError, match="extra_forbidden"):
        JobSubmission(
            network={
                "format": "package",
                "value": {"graph": {"nodes": [], "edges": []}, "bundle_ref": "bundle-1"},
            },
            training=_training(),
            package_name="nnm_legacy",
        )

    with pytest.raises(ValidationError, match="overrides"):
        JobSubmission(
            network={
                "format": "package",
                "value": {"graph": {"nodes": [], "edges": []}, "bundle_ref": "bundle-1"},
            },
            training={**_training(), "overrides": ["trainer.max_epochs=9"]},
        )

    with pytest.raises(ValidationError, match="Input should be 'package'"):
        JobSubmission(
            network={
                "format": "nntree",
                "value": {"graph": {"nodes": [], "edges": []}, "bundle_ref": "bundle-1"},
            },
            training=_training(),
        )


def test_wandb_run_and_capabilities_are_structured_contracts() -> None:
    run = WandbRun(
        mode="offline",
        id="offline-run",
        entity=None,
        project="tests",
        url=None,
    )
    status = JobStatus(
        id="job-1",
        status="succeeded",
        priority=0,
        created_at="2026-01-01T00:00:00+00:00",
        artifact_dir="/private",
        wandb_run=run,
    )
    assert status.model_dump(mode="json")["wandb_run"] == {
        "mode": "offline",
        "id": "offline-run",
        "entity": None,
        "project": "tests",
        "url": None,
    }
    capability = BackendCapabilities(
        available_modes=["disabled", "offline"],
        online={"configured": False, "entity": None, "base_url": None, "reason": "not configured"},
    )
    assert "online" not in capability.available_modes


def test_wandb_run_url_is_mode_consistent_and_safe() -> None:
    online = WandbRun(
        mode="online",
        id="run-1",
        entity="team",
        project="tests",
        url="https://wandb.example.test/runs/run-1",
    )
    assert online.url == "https://wandb.example.test/runs/run-1"

    with pytest.raises(ValidationError):
        WandbRun(mode="offline", id="run-1", entity=None, project="tests", url=online.url)
    with pytest.raises(ValidationError):
        WandbRun(mode="online", id="run-1", entity="team", project="tests", url=None)


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "file:///tmp/run",
        "data:text/plain,run",
        "not-a-url",
        "https:///missing-host",
        "https://user:password@wandb.example.test/runs/run-1",
        "https://wandb.example.test:bad/runs/run-1",
    ],
)
def test_wandb_run_rejects_unsafe_or_malformed_urls(url: str) -> None:
    with pytest.raises(ValidationError):
        WandbRun(mode="online", id="run-1", entity="team", project="tests", url=url)
