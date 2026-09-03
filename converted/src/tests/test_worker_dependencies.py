"""Regression tests for the dependencies installed in the worker image."""

from __future__ import annotations

import tomllib
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import save_file

ROOT = Path(__file__).parents[2]


def test_worker_export_dependency_closure_declares_numpy() -> None:
    """Keep NumPy explicit because safetensors' torch bridge imports it at export."""

    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    dependencies = pyproject["project"]["dependencies"]
    assert any(dependency.split(">=", 1)[0].strip() == "numpy" for dependency in dependencies)

    lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    project = next(package for package in lock["package"] if package["name"] == "mnist-fds")
    assert any(dependency["name"] == "numpy" for dependency in project["dependencies"])


def test_worker_can_serialize_safetensors_artifact(tmp_path: Path) -> None:
    """Exercise the exact tensor serialization bridge used after worker training."""

    artifact = tmp_path / "weights.safetensors"
    save_file({"weight": torch.ones(2)}, str(artifact))

    with safe_open(str(artifact), framework="pt", device="cpu") as reader:
        assert reader.get_tensor("weight").equal(torch.ones(2))
