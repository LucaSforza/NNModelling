"""Focused tests for executable package validation and graph compilation."""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
import torch

from package_runtime import PackageValidationError, compile_package_graph


def _file(source: str) -> dict[str, str]:
    content = base64.b64encode(source.encode()).decode()
    return {"content": content, "sha256": hashlib.sha256(source.encode()).hexdigest()}


def _package(package_id: str, source: str, *, version: str = "0.1.0", dependencies: dict[str, str] | None = None) -> dict[str, Any]:
    return {
        "manifest": {
            "schemaVersion": 1,
            "id": package_id,
            "version": version,
            "dependencies": dependencies or {},
            "entrypoints": {"pytorch": "pytorch.py"},
        },
        "files": {"pytorch.py": _file(source)},
    }


def _graph(package_id: str, *, parameters: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "nodes": [
            {"id": "input", "type": "input"},
            {"id": "layer", "type": "layer", "package": {"id": package_id, "version": "0.1.0"}, "parameters": parameters or {}},
        ],
        "edges": [{"source": "input", "target": "layer", "targetHandle": "in-0"}],
    }


def test_compile_package_builds_torch_module() -> None:
    source = """
import torch
from stereotype_runtime.pytorch import BuildContext, NoServices
def build(parameters, context: BuildContext, services: NoServices):
    return torch.nn.Linear(parameters['in_features'], parameters['out_features'])
"""
    model = compile_package_graph({"packages": [_package("demo.linear", source)], "graph": _graph("demo.linear", parameters={"in_features": 2, "out_features": 3})})
    assert tuple(model(torch.ones(4, 2)).shape) == (4, 3)


def test_positional_encoding_package_adds_fixed_sinusoidal_table() -> None:
    root = Path(__file__).parents[3]
    source = (root / "stereotype-packages/core/positional-encoding/pytorch.py").read_text()
    model = compile_package_graph({
        "packages": [_package("core.positional-encoding", source)],
        "graph": _graph(
            "core.positional-encoding",
            parameters={"d_model": 4, "max_len": 8},
        ),
    })

    output = model(torch.zeros(2, 3, 4))

    assert tuple(output.shape) == (2, 3, 4)
    assert torch.allclose(output[0, 0], torch.tensor([0.0, 1.0, 0.0, 1.0]))
    assert len(list(model.parameters())) == 0


def test_join_order_follows_target_handle() -> None:
    source = """
import torch
from stereotype_runtime.pytorch import BuildContext, NoServices
class Join(torch.nn.Module):
    def forward(self, *inputs): return inputs[0] if len(inputs) == 1 else inputs[0] - inputs[1]
def build(parameters, context: BuildContext, services: NoServices): return Join()
"""
    bundle = {"packages": [_package("demo.join", source)], "graph": {
        "nodes": [
            {"id": "input", "type": "input"},
            {"id": "left", "type": "layer", "package": {"id": "demo.join", "version": "0.1.0"}},
            {"id": "right", "type": "layer", "package": {"id": "demo.join", "version": "0.1.0"}},
            {"id": "join", "type": "join", "package": {"id": "demo.join", "version": "0.1.0"}},
        ],
        "edges": [
            {"source": "input", "target": "left", "targetHandle": "in-0"},
            {"source": "input", "target": "right", "targetHandle": "in-0"},
            {"source": "right", "target": "join", "targetHandle": "in-1"},
            {"source": "left", "target": "join", "targetHandle": "in-0"},
        ],
    }}
    model = compile_package_graph(bundle)
    assert torch.equal(model(torch.tensor([3.0])), torch.tensor([0.0]))


def test_matmul_package_builds_matrix_product() -> None:
    root = Path(__file__).parents[3]
    source = (root / "stereotype-packages/core/matmul/pytorch.py").read_text()
    package = _package("core.matmul", source)
    graph = {
        "nodes": [
            {"id": "input", "type": "input"},
            {"id": "matmul", "type": "join", "package": {"id": "core.matmul", "version": "0.1.0"}},
        ],
        "edges": [
            {"source": "input", "target": "matmul", "targetHandle": "in-0"},
            {"source": "input", "target": "matmul", "targetHandle": "in-1"},
            {"source": "input", "target": "matmul", "targetHandle": "in-2"},
        ],
    }
    model = compile_package_graph({"packages": [package], "graph": graph})

    assert model.modules_by_id["matmul"].__class__.__name__ == "SequentialMatMul"
    value = torch.tensor([[1.0, 2.0], [3.0, 4.0]])
    assert torch.equal(model(value), value @ value @ value)


def test_matmul_package_selects_parallel_builder_for_four_inputs() -> None:
    root = Path(__file__).parents[3]
    source = (root / "stereotype-packages/core/matmul/pytorch.py").read_text()
    package = _package("core.matmul", source)
    graph = {
        "nodes": [
            {"id": "input", "type": "input"},
            {"id": "matmul", "type": "join", "package": {"id": "core.matmul", "version": "0.1.0"}},
        ],
        "edges": [
            {"source": "input", "target": "matmul", "targetHandle": "in-0"},
            {"source": "input", "target": "matmul", "targetHandle": "in-1"},
            {"source": "input", "target": "matmul", "targetHandle": "in-2"},
            {"source": "input", "target": "matmul", "targetHandle": "in-3"},
        ],
    }
    model = compile_package_graph({"packages": [package], "graph": graph})

    assert model.modules_by_id["matmul"].__class__.__name__ == "ParallelMatMul"
    value = torch.tensor([[1.0, 2.0], [3.0, 4.0]])
    assert torch.equal(model(value), value @ value @ value @ value)


def test_rejects_arbitrary_import_and_missing_dependency() -> None:
    bad_source = "import os\ndef build(parameters, context, services): return object()\n"
    with pytest.raises(PackageValidationError, match="import 'os'"):
        compile_package_graph({"packages": [_package("demo.bad", bad_source)], "graph": _graph("demo.bad")})
    dependent = _package("demo.child", "def build(parameters, context, services): return None\n", dependencies={"demo.base": "0.1.0"})
    with pytest.raises(PackageValidationError, match="missing dependency"):
        compile_package_graph({"packages": [dependent], "graph": _graph("demo.child")})


def test_rejects_cycles() -> None:
    source = "import torch\ndef build(parameters, context, services): return torch.nn.Identity()\n"
    graph = _graph("demo.identity")
    graph["edges"].append({"source": "layer", "target": "input", "targetHandle": "in-0"})
    with pytest.raises(PackageValidationError, match="cycle"):
        compile_package_graph({"packages": [_package("demo.identity", source)], "graph": graph})


def test_subflow_service_compiles_nested_graph() -> None:
    source = """
import torch
from stereotype_runtime.pytorch import BuildContext, SubflowServices
def build(parameters, context: BuildContext, services: SubflowServices):
    return services.build_subflow()
"""
    inner = _graph("demo.identity")
    outer = {
        "nodes": [
            {"id": "input", "type": "input"},
            {"id": "nested", "type": "subflow", "package": {"id": "demo.subflow", "version": "0.1.0"}, "subflow": inner},
        ],
        "edges": [{"source": "input", "target": "nested", "targetHandle": "in-0"}],
    }
    identity = "import torch\ndef build(parameters, context, services): return torch.nn.Identity()\n"
    model = compile_package_graph({"packages": [_package("demo.subflow", source), _package("demo.identity", identity)], "graph": outer})
    value = torch.tensor([[1.0, 2.0]])
    assert torch.equal(model(value), value)


def test_subflow_proxy_builds_and_delegates_to_one_nested_graph() -> None:
    root = Path(__file__).parents[3]
    proxy_source = (root / "stereotype-packages/core/subflow-proxy/pytorch.py").read_text()
    inner_source = """
import torch
class Shift(torch.nn.Module):
    def forward(self, input): return input + 2
def build(parameters, context, services): return Shift()
"""
    inner = _graph("demo.shift")
    outer = {
        "nodes": [
            {"id": "input", "type": "input"},
            {"id": "proxy", "type": "subflow", "package": {"id": "core.subflow-proxy", "version": "0.1.0"}, "subflow": inner},
        ],
        "edges": [{"source": "input", "target": "proxy", "targetHandle": "in-0"}],
    }
    model = compile_package_graph({
        "packages": [
            _package("core.subflow-proxy", proxy_source),
            _package("demo.shift", inner_source),
        ],
        "graph": outer,
    })

    value = torch.tensor([[1.0, 2.0]])
    assert torch.equal(model(value), value + 2)


def test_frontend_vae_fixture_compiles_to_pytorch() -> None:
    """Keep the browser bundle contract executable for the canonical VAE."""

    root = Path(__file__).parents[3]
    diagram = json.loads(
        (root / "examples/diagrams/package/variational-autoencoder-complete.json").read_text()
    )
    package_ids = sorted({node["data"]["package"]["id"] for node in diagram["nodes"]})
    packages = []
    for package_id in package_ids:
        package_dir = root / "stereotype-packages" / Path(*package_id.split("."))
        manifest = json.loads((package_dir / "manifest.json").read_text())
        files = {}
        for file_path in ["manifest.json", "stereotype.json", "inference.lua"] + (
            [manifest["entrypoints"]["pytorch"]["file"]]
            if "pytorch" in manifest["entrypoints"]
            else []
        ):
            content = (package_dir / file_path).read_bytes()
            files[file_path] = {
                "content": base64.b64encode(content).decode(),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        packages.append({
            "id": manifest["id"],
            "version": manifest["version"],
            "dependencies": manifest["dependencies"],
            "manifest": manifest,
            "files": files,
        })
    graph = {
        "nodes": [
            {
                "id": node["id"],
                "type": node["type"],
                "package": node["data"]["package"],
                "params": node["data"].get("params", {}),
                "parentId": node.get("parentId"),
            }
            for node in diagram["nodes"]
        ],
        "edges": [
            {
                "source": edge["source"],
                "target": edge["target"],
                "targetHandle": edge.get("targetHandle"),
            }
            for edge in diagram["edges"]
        ],
    }
    model = compile_package_graph({"graph": graph, "packages": packages})
    output = model(torch.randn(2, 1, 28, 28), torch.randn(2, 1, 28, 28))
    assert output.ndim == 0
