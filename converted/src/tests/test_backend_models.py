"""Typed request-contract regressions for the package-native backend."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.models import JobSubmission


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
