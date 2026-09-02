"""Worker-side loading tests for project-owned dataset archives."""

from __future__ import annotations

import json
from pathlib import Path

import torch

from dataset.contracts import DatasetReference, normalize_training_batch
from training.datasets import resolve_dataset


def _write_project_dataset(root: Path) -> None:
    (root / "data").mkdir()
    (root / "data" / "marker.pt").write_bytes(b"project data")
    (root / "dataset.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "id": "demo.project-dataset",
                "version": "1.0.0",
                "name": "Project dataset",
                "parameters": [
                    {"name": "batch_size", "type": "integer", "default": 2}
                ],
                "batch": {
                    "inputs": {"value": {"shape": ["B", 1], "dtype": "float32"}},
                    "targets": {"label": {"shape": ["B"], "dtype": "int64"}},
                },
            }
        ),
        encoding="utf-8",
    )
    (root / "dataset.py").write_text(
        """
from collections.abc import Mapping
from pathlib import Path

import torch
from torch.utils.data import DataLoader, Dataset

from dataset.contracts import TrainingBatch


class OneBatch(Dataset[TrainingBatch]):
    def __init__(self, batch: TrainingBatch):
        self.batch = batch

    def __len__(self):
        return 1

    def __getitem__(self, index):
        if index != 0:
            raise IndexError(index)
        return self.batch


class ProjectDataset:
    def __init__(self, context_root: Path, reference):
        assert (context_root / "data" / "marker.pt").is_file()
        self.reference = reference

    def division(self):
        batch = TrainingBatch(
            inputs={"value": torch.ones(2, 1)},
            targets={"label": torch.zeros(2, dtype=torch.int64)},
        )
        return {
            name: DataLoader(OneBatch(batch), batch_size=None)
            for name in ("train", "validation", "test")
        }


def build(parameters: Mapping[str, object], context):
    assert parameters == {"batch_size": 2}
    return ProjectDataset(context.resource_root, context.reference)
""".strip()
        + "\n",
        encoding="utf-8",
    )


def test_resolve_project_dataset_loads_context_and_all_splits(
    tmp_path: Path, monkeypatch
) -> None:
    _write_project_dataset(tmp_path)
    monkeypatch.setenv("NNM_DATASET_ROOT", str(tmp_path))
    reference = DatasetReference(
        kind="project",
        id="demo.project-dataset",
        version="1.0.0",
        ref="dataset_" + "a" * 24,
        digest="a" * 64,
    )

    dataset, definition, resolved, parameters = resolve_dataset(
        {"dataset": {"reference": reference.model_dump(), "parameters": {}}}
    )

    assert definition.id == reference.id
    assert resolved == reference
    assert parameters == {"batch_size": 2}
    assert dataset.reference == reference
    splits = dataset.division()
    assert set(splits) == {"train", "validation", "test"}
    for loader in splits.values():
        assert normalize_training_batch(next(iter(loader))).inputs["value"].shape == (2, 1)
