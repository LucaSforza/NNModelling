"""Tests for the frozen declarative dataset boundary."""

from __future__ import annotations

from pathlib import Path

import pytest
import torch
from pydantic import ValidationError

from dataset.contracts import (
    DatasetBatchContract,
    DatasetContractError,
    DatasetDefinition,
    DatasetReference,
    ModelManifestV2,
    TrainingBatch,
    normalize_training_batch,
    parse_model_manifest,
    serialize_dataset_definition,
)
from backend.models import JobSubmission, OpaqueDatasetRequest


def _definition() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "id": "demo.tokens",
        "version": "1.0.0",
        "name": "Tokens",
        "parameters": [{"name": "max_length", "type": "integer", "default": 128}],
        "batch": {
            "inputs": {"tokens": {"shape": ["B", "T"], "dtype": "int64"}},
            "targets": {"next_tokens": {"shape": ["B", "T"], "dtype": "int64"}},
        },
    }


def test_definition_round_trip_and_canonical_json() -> None:
    definition = DatasetDefinition.model_validate(_definition())
    expected = _definition()
    expected["parameters"] = [{"name": "max_length", "type": "integer", "required": False, "default": 128}]
    assert definition.model_dump(mode="json", exclude_none=True) == expected
    assert '"batch"' in serialize_dataset_definition(definition)


def test_v1_manifest_reads_as_empty_datasets_and_marks_upgrade() -> None:
    manifest, migrated = parse_model_manifest({
        "schemaVersion": 1,
        "id": "demo.model",
        "version": "1.0.0",
        "name": "Demo",
        "customPackages": [{"id": "demo.layer", "version": "1.0.0", "path": "packages/layer"}],
    })
    assert migrated is True
    assert manifest.schemaVersion == 2
    assert manifest.customDatasets == ()
    assert manifest.customPackages[0].id == "demo.layer"


def test_model_manifest_v2_rejects_duplicate_or_escaping_entries() -> None:
    with pytest.raises((ValidationError, DatasetContractError), match="invalid-path"):
        ModelManifestV2(
            id="demo.model",
            version="1.0.0",
            name="Demo",
            customDatasets=[{"id": "demo.tokens", "version": "1.0.0", "path": "../tokens"}],
        )

    with pytest.raises((ValidationError, DatasetContractError), match="duplicate-entry"):
        ModelManifestV2(
            id="demo.model",
            version="1.0.0",
            name="Demo",
            customDatasets=[
                {"id": "demo.tokens", "version": "1.0.0", "path": "datasets/a"},
                {"id": "demo.tokens", "version": "1.0.0", "path": "datasets/b"},
            ],
        )


def test_slots_reject_unknown_dtypes_and_duplicates() -> None:
    with pytest.raises((ValidationError, DatasetContractError), match="unsupported-dtype"):
        DatasetBatchContract(inputs={"tokens": {"shape": ["B"], "dtype": "complex128"}})
    with pytest.raises((ValidationError, DatasetContractError), match="duplicate-entry"):
        DatasetBatchContract(
            inputs={"tokens": {"shape": ["B"], "dtype": "int64"}},
            targets={"tokens": {"shape": ["B"], "dtype": "int64"}},
        )


def test_training_batch_is_flat_named_tensor_maps_and_moves_device() -> None:
    batch = normalize_training_batch({
        "inputs": {"tokens": torch.ones(2, 3, dtype=torch.int64)},
        "targets": {"next_tokens": torch.zeros(2, 3, dtype=torch.int64)},
    })
    assert isinstance(batch, TrainingBatch)
    assert set(batch.inputs) == {"tokens"}
    assert batch.to("cpu").inputs["tokens"].device.type == "cpu"

    with pytest.raises(DatasetContractError, match="invalid-slot"):
        normalize_training_batch((torch.ones(2), torch.ones(2)))
    with pytest.raises(DatasetContractError, match="invalid-slot"):
        TrainingBatch(inputs={"tokens": [1, 2]}, targets={})  # type: ignore[arg-type]


def test_reference_requires_opaque_project_digest() -> None:
    reference = DatasetReference(kind="project", id="demo.tokens", version="1.0.0", ref="dataset_abc", digest="A" * 64)
    assert reference.digest == "A" * 64
    with pytest.raises((ValidationError, DatasetContractError), match="invalid-reference"):
        DatasetReference(kind="project", id="demo.tokens", version="1.0.0", ref="datasets/tokens", digest="A" * 64)
    with pytest.raises((ValidationError, DatasetContractError), match="invalid-reference"):
        DatasetReference(kind="project", id="demo.tokens", version="1.0.0", ref="dataset_abc")


def test_opaque_request_has_no_python_target_or_path() -> None:
    request = OpaqueDatasetRequest(
        reference={"kind": "builtin", "id": "builtin.mnist", "version": "1.0.0", "ref": "builtin_mnist"},
        parameters={"batch_size": 32},
    )
    assert request.model_dump(mode="json") == {
        "reference": {"kind": "builtin", "id": "builtin.mnist", "version": "1.0.0", "ref": "builtin_mnist", "digest": None},
        "parameters": {"batch_size": 32},
    }
    with pytest.raises(ValidationError):
        OpaqueDatasetRequest(
            reference={"kind": "builtin", "id": "builtin.mnist", "version": "1.0.0", "ref": "builtin_mnist"},
            parameters={"root": Path("/tmp")},
        )

    submission = JobSubmission(
        network={"format": "package", "value": {"graph": {}, "bundle_ref": "bundle-1"}},
        training={
            "dataset": {
                "reference": {"kind": "builtin", "id": "builtin.mnist", "version": "1.0.0", "ref": "builtin_mnist"},
                "parameters": {"batch_size": 32},
            }
        },
    )
    assert submission.training.dataset.reference.ref == "builtin_mnist"  # type: ignore[union-attr]
