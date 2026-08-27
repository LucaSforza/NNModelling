"""Public API tests for package-native portable model wheels."""

from __future__ import annotations

import base64
import hashlib
import importlib
import json
import sys
import zipfile
from pathlib import Path

import pytest
import torch
from safetensors.torch import save_file

from model_package.adapters import adapter_spec_for_dataset
from model_package.exporter import build_model_wheel
from package_runtime.compiler import compile_package_graph


ROOT = Path(__file__).parents[3]
CORE = ROOT / "stereotype-packages" / "core"


def test_dataset_adapter_uses_registered_target() -> None:
    """Dataset adapter metadata comes from the trusted dataset catalog."""

    assert adapter_spec_for_dataset("dataset.mnist.MNISTDataset") == {
        "kind": "image",
        "version": 1,
        "channels": 1,
        "size": [28, 28],
        "mean": [0.1307],
        "std": [0.3081],
    }


def test_dataset_adapter_rejects_unregistered_target() -> None:
    with pytest.raises(ValueError, match="not registered"):
        adapter_spec_for_dataset("not.trusted.Dataset")


def _package(package_id: str) -> dict[str, object]:
    directory = CORE / package_id.removeprefix("core.")
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    files: dict[str, dict[str, str]] = {}
    for filename in ("manifest.json", "stereotype.json", "inference.lua", "pytorch.py"):
        path = directory / filename
        if path.is_file():
            content = path.read_bytes()
            files[filename] = {
                "content": base64.b64encode(content).decode("ascii"),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
    return {"manifest": manifest, "files": files}


def _synthetic_package(package_id: str, source: str, definition: dict[str, object]) -> dict[str, object]:
    def file(content: bytes) -> dict[str, str]:
        return {"content": base64.b64encode(content).decode("ascii"), "sha256": hashlib.sha256(content).hexdigest()}

    definition_bytes = json.dumps(definition, sort_keys=True).encode("utf-8")
    source_bytes = source.encode("utf-8")
    return {
        "manifest": {
            "schemaVersion": 1,
            "id": package_id,
            "version": "0.1.0",
            "dependencies": {},
            "entrypoints": {"pytorch": "pytorch.py"},
        },
        "files": {"pytorch.py": file(source_bytes), "stereotype.json": file(definition_bytes)},
    }


def _bundle(nodes: list[dict[str, object]], edges: list[dict[str, str]], package_ids: list[str]) -> dict[str, object]:
    return {
        "schema_version": 1,
        "format": "package-bundle/v1",
        "packages": [_package(package_id) for package_id in package_ids],
        "graph": {"nodes": nodes, "edges": edges},
    }


def _wheel_model(tmp_path: Path, bundle: dict[str, object], name: str) -> tuple[Path, object]:
    artifact = tmp_path / name
    artifact.mkdir()
    compiled = compile_package_graph(bundle)
    save_file(compiled.state_dict(), artifact / "weights.safetensors")
    wheel = build_model_wheel(artifact, package_name=f"nnm_{name}", package=bundle)
    sys.path.insert(0, str(wheel))
    module = importlib.import_module(f"nnm_{name}")
    return wheel, module


def _cleanup(name: str, wheel: Path) -> None:
    sys.path.remove(str(wheel))
    for module_name in list(sys.modules):
        if module_name == f"nnm_{name}" or module_name.startswith(f"nnm_{name}."):
            del sys.modules[module_name]


def test_classifier_wheel_exposes_logits_without_a_target(tmp_path: Path) -> None:
    bundle = _bundle(
        [
            {"id": "input", "type": "input"},
            {"id": "classifier", "type": "layer", "package": {"id": "core.linear", "version": "0.1.0"}, "parameters": {"in_features": 2, "out_features": 3}},
            {"id": "prediction", "type": "layer", "package": {"id": "core.output", "version": "0.1.0"}, "parameters": {}},
            {"id": "loss", "type": "layer", "package": {"id": "core.cross-entropy", "version": "0.1.0"}, "parameters": {}},
        ],
        [
            {"source": "input", "target": "classifier", "targetHandle": "in-0"},
            {"source": "classifier", "target": "prediction", "targetHandle": "in-0"},
            {"source": "classifier", "target": "loss", "targetHandle": "in-0"},
        ],
        ["core.linear", "core.output", "core.cross-entropy"],
    )
    wheel, module = _wheel_model(tmp_path, bundle, "classifier")
    try:
        model = module.load_model()
        output = model.predict_tensor(torch.randn(4, 2))
        assert output.shape == (4, 3)
    finally:
        _cleanup("classifier", wheel)


def test_wheel_exposes_selected_stereotype_adapter_without_model_internals(tmp_path: Path) -> None:
    layer = _synthetic_package(
        "demo.decoder",
        "import torch\ndef build(parameters, context, services): return torch.nn.Linear(2, 2, bias=False)\n",
        {
            "kind": "layer",
            "wheelAdapters": [{
                "name": "decode",
                "entrypoint": "module.forward",
                "input": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"},
                "output": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"},
                "targetPolicy": "forbidden",
                "randomness": {"mode": "none"},
            }],
        },
    )
    output = _package("core.output")
    bundle = {
        "packages": [layer, output],
        "graph": {
            "nodes": [
                {"id": "input", "type": "input"},
                {"id": "decoder", "type": "layer", "package": {"id": "demo.decoder", "version": "0.1.0"}, "wheelAdapters": ["decode"]},
                {"id": "output", "type": "layer", "package": {"id": "core.output", "version": "0.1.0"}},
            ],
            "edges": [
                {"source": "input", "target": "decoder", "targetHandle": "in-0"},
                {"source": "decoder", "target": "output", "targetHandle": "in-0"},
            ],
        },
    }
    wheel, module = _wheel_model(tmp_path, bundle, "adapter")
    try:
        model = module.load_model()
        value = [[1, 2], [3, 4], [5, 6]]
        output = model.adapter("decode").run(value)
        assert output.dtype == torch.float32
        assert tuple(output.shape) == (3, 2)
        assert not hasattr(model, "network")
    finally:
        _cleanup("adapter", wheel)


def test_vae_wheel_returns_reconstruction_and_never_executes_mse_or_kl(tmp_path: Path) -> None:
    bundle = _bundle(
        [
            {"id": "input", "type": "input"},
            {"id": "reconstruction", "type": "layer", "package": {"id": "core.linear", "version": "0.1.0"}, "parameters": {"in_features": 2, "out_features": 2}},
            {"id": "statistics", "type": "layer", "package": {"id": "core.linear", "version": "0.1.0"}, "parameters": {"in_features": 2, "out_features": 4}},
            {"id": "prediction", "type": "layer", "package": {"id": "core.output", "version": "0.1.0"}, "parameters": {}},
            {"id": "mse", "type": "layer", "package": {"id": "core.mse-loss", "version": "0.1.0"}, "parameters": {}},
            {"id": "kl", "type": "layer", "package": {"id": "core.kl-divergence", "version": "0.1.0"}, "parameters": {}},
            {"id": "objective", "type": "layer", "package": {"id": "core.add", "version": "0.1.0"}, "parameters": {}},
        ],
        [
            {"source": "input", "target": "reconstruction", "targetHandle": "in-0"},
            {"source": "input", "target": "statistics", "targetHandle": "in-0"},
            {"source": "reconstruction", "target": "prediction", "targetHandle": "in-0"},
            {"source": "reconstruction", "target": "mse", "targetHandle": "in-0"},
            {"source": "statistics", "target": "kl", "targetHandle": "in-0"},
            {"source": "mse", "target": "objective", "targetHandle": "in-0"},
            {"source": "kl", "target": "objective", "targetHandle": "in-1"},
        ],
        ["core.linear", "core.output", "core.mse-loss", "core.kl-divergence", "core.add"],
    )
    wheel, module = _wheel_model(tmp_path, bundle, "vae")
    try:
        output = module.load_model().predict_tensor(torch.randn(5, 2))
        assert output.shape == (5, 2)
    finally:
        _cleanup("vae", wheel)


def test_wheel_rejects_resolved_config_only_export(tmp_path: Path) -> None:
    artifact = tmp_path / "artifact"
    artifact.mkdir()
    with pytest.raises(ValueError, match="package must contain"):
        build_model_wheel(artifact, package_name="nnm_legacy")


def test_wheel_contains_no_legacy_runtime_or_resolved_config(tmp_path: Path) -> None:
    bundle = _bundle(
        [
            {"id": "input", "type": "input"},
            {"id": "linear", "type": "layer", "package": {"id": "core.linear", "version": "0.1.0"}, "parameters": {"in_features": 1, "out_features": 1}},
            {"id": "output", "type": "layer", "package": {"id": "core.output", "version": "0.1.0"}, "parameters": {}},
        ],
        [
            {"source": "input", "target": "linear", "targetHandle": "in-0"},
            {"source": "linear", "target": "output", "targetHandle": "in-0"},
        ],
        ["core.linear", "core.output"],
    )
    wheel, _ = _wheel_model(tmp_path, bundle, "contents")
    try:
        with zipfile.ZipFile(wheel) as archive:
            names = set(archive.namelist())
            text = "\n".join(archive.read(name).decode("utf-8", errors="ignore") for name in names if name.endswith((".py", ".json")))
        assert not any("resolved_config" in name or name.endswith("ops.py") for name in names)
        assert "GraphNet" not in text
        assert "omegaconf" not in text
        assert "hydra" not in text.lower()
    finally:
        _cleanup("contents", wheel)
