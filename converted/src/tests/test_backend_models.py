"""Typed request-contract regressions for the package-native backend."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.models import JobSubmission


def _training() -> dict[str, object]:
    return {"dataset": {"target": "dataset.mnist.MNISTDataset"}}


def test_dataset_parameters_are_typed_and_owned_by_dataset_request() -> None:
    submission = JobSubmission(
        network={"format": "package", "value": {"graph": {}, "bundle_ref": "bundle-1"}},
        training={
            **_training(),
            "dataset": {
                "target": "dataset.mnist.MNISTDataset",
                "parameters": {"batch_size": "64", "num_workers": "0", "train_size": "0.05"},
            },
        },
    )

    assert submission.training.dataset.parameters == {"batch_size": 64, "num_workers": 0, "train_size": 0.05}

    with pytest.raises(ValidationError, match="unknown dataset parameter"):
        JobSubmission(
            network={"format": "package", "value": {"graph": {}, "bundle_ref": "bundle-1"}},
            training={**_training(), "dataset": {"target": "dataset.mnist.MNISTDataset", "parameters": {"nope": 1}}},
        )


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
