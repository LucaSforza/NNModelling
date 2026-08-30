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


def _package(package_id: str, source: str, *, version: str = "0.1.0", dependencies: dict[str, str] | None = None, definition: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "manifest": {
            "schemaVersion": 1,
            "id": package_id,
            "version": version,
            "dependencies": dependencies or {},
            "entrypoints": {"pytorch": "pytorch.py"},
        },
        "files": {"pytorch.py": _file(source)} | ({"stereotype.json": _file(json.dumps(definition))} if definition else {}),
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


def test_cross_entropy_objective_receives_target() -> None:
    source = """
import torch
from stereotype_runtime.pytorch import BuildContext, NoServices
def build(parameters, context: BuildContext, services: NoServices):
    return torch.nn.CrossEntropyLoss()
"""
    package = _package("demo.cross-entropy", source, definition={
        "kind": "loss", "objective": {"externalInputs": [{"name": "target", "source": "batch.targets.target"}]}
    })
    output_source = "import torch\ndef build(parameters, context, services): return torch.nn.Identity()\n"
    output = _package("demo.output", output_source, definition={"kind": "output"})
    graph = {"nodes": [
        {"id": "input", "type": "input"},
        {"id": "loss", "type": "layer", "package": {"id": "demo.cross-entropy", "version": "0.1.0"}},
        {"id": "output", "type": "layer", "package": {"id": "demo.output", "version": "0.1.0"}},
    ], "edges": [
        {"source": "input", "target": "loss", "targetHandle": "in-0"},
        {"source": "input", "target": "output", "targetHandle": "in-0"},
    ]}
    model = compile_package_graph({"packages": [package, output], "graph": graph})
    loss = model.objective(torch.tensor([[2.0, -1.0], [-1.0, 2.0]]), torch.tensor([0, 1]))
    assert torch.isfinite(loss)
    assert torch.equal(model.prediction(torch.tensor([[2.0, -1.0]])), torch.tensor([[2.0, -1.0]]))


def test_reparameterize_is_deterministic_in_eval_but_stochastic_in_train() -> None:
    root = Path(__file__).parents[3]
    source = (root / "examples/diagrams/package/models/variational-autoencoder/packages/sampling/pytorch.py").read_text()
    model = compile_package_graph({
        "packages": [_package("example.vae.sampling", source)],
        "graph": _graph("example.vae.sampling", parameters={"epsilon_scale": 1.0}),
    })
    packed = torch.tensor([[1.0, 2.0, 0.0, 0.0]])
    model.eval()
    assert torch.equal(model.prediction(packed), model.prediction(packed))
    model.train()
    assert not torch.equal(model.prediction(packed), model.prediction(packed))


def test_scale_package_multiplies_objective_scalar_without_worker_logic() -> None:
    root = Path(__file__).parents[3]
    source = (root / "stereotype-packages/core/scale/pytorch.py").read_text()
    model = compile_package_graph({
        "packages": [_package("core.scale", source)],
        "graph": _graph("core.scale", parameters={"factor": 0.1}),
    })
    assert torch.equal(model.prediction(torch.tensor([5.0])), torch.tensor([0.5]))


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
        (root / "examples/diagrams/package/models/variational-autoencoder/model.json").read_text()
    )
    package_ids = sorted({node["data"]["package"]["id"] for node in diagram["nodes"]})
    packages = []
    for package_id in package_ids:
        package_ref = next((entry for entry in diagram["manifest"]["customPackages"] if entry["id"] == package_id), None)
        package_dir = (
            root / "examples/diagrams/package/models/variational-autoencoder" / package_ref["path"]
            if package_ref is not None
            else root / "stereotype-packages" / Path(*package_id.split("."))
        )
        manifest = json.loads((package_dir / "manifest.json").read_text())
        files = {}
        for file_path in sorted(path.relative_to(package_dir).as_posix() for path in package_dir.rglob("*") if path.is_file()):
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
    inputs = torch.randn(2, 1, 28, 28)
    # MSE declares flatten_batch, so the worker can pass the dataset's native
    # image-shaped target while the graph's decoder remains flattened.
    targets = inputs
    output = model.prediction(inputs)
    objective = model.objective(inputs, targets)
    assert output.shape == targets.flatten(1).shape
    assert objective.ndim == 0
    package_by_id = {package["manifest"]["id"]: package for package in packages}
    assert package_by_id["example.vae.sampling"]["files"]["pytorch.py"]["content"]
    assert package_by_id["example.vae.kl-divergence"]["files"]["pytorch.py"]["content"]


def test_resnet_mnist_fixture_forwards_logits_for_registered_mnist() -> None:
    """The package ResNet is an executable ten-class MNIST classifier."""
    root = Path(__file__).parents[3]
    diagram = json.loads((root / "examples/diagrams/package/models/resnet/model.json").read_text())
    assert diagram["manifest"]["customPackages"] == []
    package_ids = sorted({node["data"]["package"]["id"] for node in diagram["nodes"]})
    packages = []
    for package_id in package_ids:
        package_dir = root / "stereotype-packages" / Path(*package_id.split("."))
        manifest = json.loads((package_dir / "manifest.json").read_text())
        files = {}
        for file_path in sorted(path.relative_to(package_dir).as_posix() for path in package_dir.rglob("*") if path.is_file()):
            content = (package_dir / file_path).read_bytes()
            files[file_path] = {
                "content": base64.b64encode(content).decode(),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        packages.append({"manifest": manifest, "files": files})
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
            {"source": edge["source"], "target": edge["target"], "targetHandle": edge.get("targetHandle")}
            for edge in diagram["edges"]
        ],
    }
    model = compile_package_graph({"graph": graph, "packages": packages})
    logits = model(torch.randn(4, 1, 28, 28))
    labels = torch.tensor([0, 1, 2, 3])
    assert tuple(logits.shape) == (4, 10)
    assert torch.isfinite(torch.nn.functional.cross_entropy(logits, labels))
    assert not any(package["manifest"]["id"].startswith("example.vae.") for package in packages)


def _role_packages(*, binding: dict[str, Any] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    loss_source = "import torch\ndef build(parameters, context, services): return torch.nn.MSELoss()\n"
    output_source = "import torch\ndef build(parameters, context, services): return torch.nn.Identity()\n"
    loss = _package(
        "demo.loss",
        loss_source,
        definition={"kind": "loss", "objective": {"externalInputs": [binding or {"name": "reference", "source": "batch.targets.target"}]}},
    )
    output = _package("demo.output", output_source, definition={"kind": "output"})
    return loss, output


def _role_graph(*, output_ids: tuple[str, ...] = ("output",), loss_ids: tuple[str, ...] = ("loss",), disconnected: bool = False) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = [{"id": "input", "type": "input"}]
    edges: list[dict[str, Any]] = []
    for node_id in output_ids:
        nodes.append({"id": node_id, "type": "layer", "package": {"id": "demo.output", "version": "0.1.0"}})
        edges.append({"source": "input", "target": node_id, "targetHandle": "in-0"})
    for node_id in loss_ids:
        nodes.append({"id": node_id, "type": "layer", "package": {"id": "demo.loss", "version": "0.1.0"}})
        edges.append({"source": "input", "target": node_id, "targetHandle": "in-0"})
    if disconnected:
        nodes.append({"id": "orphan", "type": "layer", "package": {"id": "demo.output", "version": "0.1.0"}})
    return {"nodes": nodes, "edges": edges}


def test_prediction_and_objective_programs_reject_invalid_roles() -> None:
    loss, output = _role_packages()
    with pytest.raises(PackageValidationError, match="explicit output"):
        compile_package_graph({"packages": [loss, output], "graph": _role_graph(output_ids=())})
    with pytest.raises(PackageValidationError, match="at most one"):
        compile_package_graph({"packages": [loss, output], "graph": _role_graph(output_ids=("output-a", "output-b"), loss_ids=())})
    with pytest.raises(PackageValidationError, match="one objective terminal"):
        compile_package_graph({"packages": [loss, output], "graph": _role_graph(loss_ids=("loss-a", "loss-b"))})
    with pytest.raises(PackageValidationError, match="exactly one input root"):
        compile_package_graph({"packages": [loss, output], "graph": _role_graph(disconnected=True, loss_ids=())})


def test_prediction_only_graph_rejects_objective_execution() -> None:
    _, output = _role_packages()
    model = compile_package_graph({"packages": [output], "graph": _role_graph(loss_ids=())})
    with pytest.raises(PackageValidationError, match="requires an objective node"):
        model.objective(torch.ones(2, 1), torch.ones(2, 1))


def test_declared_wheel_adapter_binds_one_compiled_module() -> None:
    source = """
import torch
def build(parameters, context, services): return torch.nn.Linear(2, 2, bias=False)
"""
    definition = {
        "kind": "layer",
        "wheelAdapters": [{
            "name": "decode",
            "entrypoint": "module.forward",
            "input": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"},
            "output": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"},
            "targetPolicy": "forbidden",
            "randomness": {"mode": "none"},
        }],
    }
    package = _package("demo.decoder", source, definition=definition)
    output = _package("demo.output", "import torch\ndef build(parameters, context, services): return torch.nn.Identity()\n", definition={"kind": "output"})
    graph = {"nodes": [
        {"id": "input", "type": "input"},
            {"id": "decoder", "type": "layer", "package": {"id": "demo.decoder", "version": "0.1.0"}, "wheelAdapters": [{"name": "decode", "input": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"}, "output": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"}}]},
        {"id": "output", "type": "layer", "package": {"id": "demo.output", "version": "0.1.0"}},
    ], "edges": [
        {"source": "input", "target": "decoder", "targetHandle": "in-0"},
        {"source": "decoder", "target": "output", "targetHandle": "in-0"},
    ]}
    model = compile_package_graph({"packages": [package, output], "graph": graph})
    value = torch.randn(3, 2)
    assert torch.equal(model.adapter("decode")(value), model.prediction(value))
    with pytest.raises(KeyError, match="unknown wheel adapter"):
        model.adapter("sample")


def test_wheel_adapter_coerces_numeric_sequences_and_enforces_shape_and_dtype() -> None:
    source = """
import torch
def build(parameters, context, services): return torch.nn.Identity()
"""
    definition = {
        "kind": "layer",
        "wheelAdapters": [{
            "name": "decode",
            "entrypoint": "module.forward",
            "input": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"},
            "output": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"},
            "targetPolicy": "forbidden",
        }],
    }
    package = _package("demo.adapter-shape", source, definition=definition)
    graph = _graph("demo.adapter-shape")
    graph["nodes"][1]["wheelAdapters"] = [{"name": "decode", "input": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"}, "output": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"}}]
    model = compile_package_graph({"packages": [package], "graph": graph})

    output = model.adapter("decode")([[1, 2], [3, 4]])
    assert output.dtype == torch.float32
    assert tuple(output.shape) == (2, 2)
    with pytest.raises(TypeError, match="input dtype"):
        model.adapter("decode")(torch.ones(2, 2, dtype=torch.float64))
    with pytest.raises(ValueError, match="dimension"):
        model.adapter("decode")(torch.ones(2, 3))
    with pytest.raises(TypeError, match="numeric sequence"):
        model.adapter("decode")([["not", "numeric"]])


def test_wheel_adapter_enforces_output_shape_and_shared_symbol_bindings() -> None:
    source = """
import torch
class Flatten(torch.nn.Module):
    def forward(self, value): return value.flatten(1)
def build(parameters, context, services): return Flatten()
"""
    definition = {
        "kind": "layer",
        "wheelAdapters": [{
            "name": "flatten",
            "entrypoint": "module.forward",
            "input": {"type": "tensor", "shape": ["B", 2, 2], "dtype": "float32"},
            "output": {"type": "tensor", "shape": ["B", 4], "dtype": "float32"},
            "targetPolicy": "forbidden",
        }],
    }
    package = _package("demo.adapter-output", source, definition=definition)
    graph = _graph("demo.adapter-output")
    graph["nodes"][1]["wheelAdapters"] = [{"name": "flatten", "input": {"type": "tensor", "shape": ["B", 2, 2], "dtype": "float32"}, "output": {"type": "tensor", "shape": ["B", 4], "dtype": "float32"}}]
    model = compile_package_graph({"packages": [package], "graph": graph})
    assert tuple(model.adapter("flatten")(torch.ones(3, 2, 2)).shape) == (3, 4)

    output_only_symbol_definition = {**definition, "wheelAdapters": [{
        **definition["wheelAdapters"][0],
        "output": {"type": "tensor", "shape": ["B", "M"], "dtype": "float32"},
    }]}
    output_only_symbol_package = _package("demo.adapter-output", source, definition=output_only_symbol_definition)
    output_only_symbol_model = compile_package_graph({"packages": [output_only_symbol_package], "graph": graph})
    assert tuple(output_only_symbol_model.adapter("flatten")(torch.ones(3, 2, 2)).shape) == (3, 4)

    bad_output_definition = {**definition, "wheelAdapters": [{
        **definition["wheelAdapters"][0],
        "output": {"type": "tensor", "shape": ["B", 5], "dtype": "float32"},
    }]}
    bad_output_package = _package("demo.adapter-output", source, definition=bad_output_definition)
    with pytest.raises(PackageValidationError, match="binding dimension"):
        compile_package_graph({"packages": [bad_output_package], "graph": graph}).adapter("flatten")(torch.ones(3, 2, 2))

    bad_dtype_source = source.replace("value.flatten(1)", "value.flatten(1).double()")
    bad_dtype_package = _package("demo.adapter-output", bad_dtype_source, definition=definition)
    with pytest.raises(TypeError, match="output dtype"):
        compile_package_graph({"packages": [bad_dtype_package], "graph": graph}).adapter("flatten")(torch.ones(3, 2, 2))

    bad_symbol_definition = {**definition, "wheelAdapters": [{
        **definition["wheelAdapters"][0],
        "input": {"type": "tensor", "shape": ["B", "B", 2], "dtype": "float32"},
    }]}
    bad_symbol_package = _package("demo.adapter-output", source, definition=bad_symbol_definition)
    with pytest.raises(PackageValidationError, match="preserve batch symbol"):
        compile_package_graph({"packages": [bad_symbol_package], "graph": graph}).adapter("flatten")(torch.ones(3, 2, 2))


def test_wheel_adapter_binds_concrete_n32_m784_schema_without_template_metadata() -> None:
    source = """
import torch
def build(parameters, context, services): return torch.nn.Linear(4, 784)
"""
    definition = {
        "kind": "layer",
        "wheelAdapters": [{
            "name": "decode",
            "entrypoint": "module.forward",
            "input": {"type": "tensor", "shape": ["N", 4], "dtype": "float32"},
            "output": {"type": "tensor", "shape": ["N", 784], "dtype": "float32"},
            "targetPolicy": "forbidden",
        }],
    }
    binding = {"name": "decode", "input": {"type": "tensor", "shape": [32, 4], "dtype": "float32"}, "output": {"type": "tensor", "shape": [32, 784], "dtype": "float32"}}
    package = _package("demo.n32-m784", source, definition=definition)
    graph = _graph("demo.n32-m784")
    graph["nodes"][1]["wheelAdapters"] = [binding]
    model = compile_package_graph({"packages": [package], "graph": graph})
    assert tuple(model.adapter("decode")(torch.ones(32, 4)).shape) == (32, 784)
    assert model.adapter_specs[0]["input"]["shape"] == [32, 4]
    assert model.adapter_specs[0]["output"]["shape"] == [32, 784]
    assert "N" not in model.adapter_specs[0]["input"]["shape"]

    legacy_graph = {**graph, "nodes": [{**graph["nodes"][0]}, {**graph["nodes"][1], "wheelAdapters": ["decode"]}]}
    with pytest.raises(PackageValidationError, match="must be an object"):
        compile_package_graph({"packages": [package], "graph": legacy_graph})

    incompatible = {**binding, "output": {"type": "tensor", "shape": [32, 785], "dtype": "float32"}}
    incompatible_graph = {**graph, "nodes": [{**graph["nodes"][0]}, {**graph["nodes"][1], "wheelAdapters": [incompatible]}]}
    with pytest.raises(PackageValidationError, match="dimension .* incompatible"):
        compile_package_graph({"packages": [package], "graph": incompatible_graph})


def test_wheel_adapter_concrete_schema_accepts_dynamic_batch_symbol() -> None:
    source = "import torch\ndef build(parameters, context, services): return torch.nn.Identity()\n"
    definition = {
        "kind": "layer",
        "wheelAdapters": [{
            "name": "identity",
            "entrypoint": "module.forward",
            "input": {"type": "tensor", "shape": ["B", 4], "dtype": "float32"},
            "output": {"type": "tensor", "shape": ["B", 4], "dtype": "float32"},
            "targetPolicy": "forbidden",
        }],
    }
    package = _package("demo.dynamic-batch", source, definition=definition)
    graph = _graph("demo.dynamic-batch")
    graph["nodes"][1]["wheelAdapters"] = [{
        "name": "identity",
        "input": {"type": "tensor", "shape": ["B", 4], "dtype": "float32"},
        "output": {"type": "tensor", "shape": ["B", 4], "dtype": "float32"},
    }]
    model = compile_package_graph({"packages": [package], "graph": graph})
    assert tuple(model.adapter("identity")(torch.ones(7, 4)).shape) == (7, 4)


@pytest.mark.parametrize("shape", [["N", 4], [4, "B"], ["B", "M"]])
def test_wheel_adapter_rejects_noncanonical_concrete_shape_symbols(shape: list[object]) -> None:
    source = "import torch\ndef build(parameters, context, services): return torch.nn.Identity()\n"
    definition = {
        "kind": "layer",
        "wheelAdapters": [{
            "name": "identity",
            "entrypoint": "module.forward",
            "input": {"type": "tensor", "shape": ["B", 4], "dtype": "float32"},
            "output": {"type": "tensor", "shape": ["B", 4], "dtype": "float32"},
            "targetPolicy": "forbidden",
        }],
    }
    package = _package("demo.invalid-concrete", source, definition=definition)
    graph = _graph("demo.invalid-concrete")
    graph["nodes"][1]["wheelAdapters"] = [{
        "name": "identity",
        "input": {"type": "tensor", "shape": shape, "dtype": "float32"},
        "output": {"type": "tensor", "shape": ["B", 4], "dtype": "float32"},
    }]
    with pytest.raises(PackageValidationError, match="shape must use B only as its first dimension"):
        compile_package_graph({"packages": [package], "graph": graph})


@pytest.mark.parametrize(
    ("entrypoint", "message"),
    [("decode", "module.forward"), ("module.forward", "targetPolicy")],
)
def test_wheel_adapter_requires_fixed_target_free_protocol(entrypoint: str, message: str) -> None:
    definition = {
        "kind": "layer",
        "wheelAdapters": [{
            "name": "decode",
            "entrypoint": entrypoint,
            "input": {"type": "tensor", "shape": [2, 2], "dtype": "float32"},
            "output": {"type": "tensor", "shape": [2, 2], "dtype": "float32"},
            "targetPolicy": "allowed" if message == "targetPolicy" else "forbidden",
        }],
    }
    package = _package("demo.adapter", "import torch\ndef build(parameters, context, services): return torch.nn.Identity()\n", definition=definition)
    graph = _graph("demo.adapter")
    graph["nodes"][1]["wheelAdapters"] = [{"name": "decode", "input": {"type": "tensor", "shape": [2, 2], "dtype": "float32"}, "output": {"type": "tensor", "shape": [2, 2], "dtype": "float32"}}]
    with pytest.raises(PackageValidationError, match=message):
        compile_package_graph({"packages": [package], "graph": graph})


def test_wheel_adapter_can_expose_declared_sample_capability() -> None:
    source = """
import torch
from stereotype_runtime.pytorch import BuildContext, NoServices
class Sampler(torch.nn.Module):
    def forward(self, value):
        return value
    def sample(self, value):
        return value + torch.randn_like(value)
def build(parameters, context: BuildContext, services: NoServices):
    return Sampler()
"""
    definition = {
        "kind": "layer",
        "wheelAdapters": [{
            "name": "sample", "entrypoint": "module.sample",
            "input": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"},
            "output": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"},
            "targetPolicy": "forbidden", "randomness": {"mode": "random"},
        }],
    }
    package = _package("demo.sampler", source, definition=definition)
    graph = _graph("demo.sampler")
    graph["nodes"][1]["wheelAdapters"] = [{
        "name": "sample", "input": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"},
        "output": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"},
    }]
    model = compile_package_graph({"packages": [package], "graph": graph})
    torch.manual_seed(7)
    first = model.adapter("sample")(torch.zeros(2, 2))
    torch.manual_seed(7)
    second = model.adapter("sample")(torch.zeros(2, 2))
    assert torch.equal(first, second)
    assert not torch.equal(first, torch.zeros(2, 2))


def test_empty_wheel_adapter_selections_are_ignored_on_non_module_nodes() -> None:
    adapter_definition = {
        "kind": "layer",
        "wheelAdapters": [{
            "name": "decode",
            "entrypoint": "module.forward",
            "input": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"},
            "output": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"},
            "targetPolicy": "forbidden",
        }],
    }
    adapter = _package("demo.selected-adapter", "import torch\ndef build(parameters, context, services): return torch.nn.Identity()\n", definition=adapter_definition)
    loss = _package(
        "demo.loss-with-empty-selection",
        "import torch\ndef build(parameters, context, services): return torch.nn.MSELoss()\n",
        definition={"kind": "loss", "objective": {"externalInputs": [{"name": "target", "source": "batch.targets.target"}]}},
    )
    output = _package("demo.output-with-empty-selection", "import torch\ndef build(parameters, context, services): return torch.nn.Identity()\n", definition={"kind": "output"})
    graph = {"nodes": [
        {"id": "input", "type": "input", "wheelAdapters": []},
            {"id": "selected", "type": "layer", "package": {"id": "demo.selected-adapter", "version": "0.1.0"}, "wheelAdapters": [{"name": "decode", "input": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"}, "output": {"type": "tensor", "shape": ["B", 2], "dtype": "float32"}}]},
        {"id": "loss", "type": "layer", "package": {"id": "demo.loss-with-empty-selection", "version": "0.1.0"}, "wheelAdapters": []},
        {"id": "output", "type": "layer", "package": {"id": "demo.output-with-empty-selection", "version": "0.1.0"}, "wheelAdapters": []},
    ], "edges": [
        {"source": "input", "target": "selected", "targetHandle": "in-0"},
        {"source": "input", "target": "loss", "targetHandle": "in-0"},
        {"source": "input", "target": "output", "targetHandle": "in-0"},
    ]}
    model = compile_package_graph({"packages": [adapter, loss, output], "graph": graph})
    assert tuple(model.adapter("decode")(torch.ones(2, 2)).shape) == (2, 2)


@pytest.mark.parametrize(
    ("binding", "message"),
    [
        ({"name": "reference", "source": "batch.inputs"}, "binding source"),
        ({"name": "reference", "source": "batch.targets.target"}, ""),
    ],
)
def test_objective_bindings_are_named_and_source_driven(binding: dict[str, Any], message: str) -> None:
    loss, output = _role_packages(binding=binding)
    if message:
        with pytest.raises(PackageValidationError, match=message):
            compile_package_graph({"packages": [loss, output], "graph": _role_graph()})
    else:
        model = compile_package_graph({"packages": [loss, output], "graph": _role_graph()})
        assert torch.isfinite(model.objective(torch.ones(2, 1), torch.zeros(2, 1)))


def test_duplicate_objective_binding_names_are_rejected() -> None:
    loss, output = _role_packages()
    loss["files"]["stereotype.json"] = _file(json.dumps({
        "kind": "loss",
        "objective": {"externalInputs": [
            {"name": "reference", "source": "batch.targets.target"},
            {"name": "reference", "source": "batch.targets.target"},
        ]},
    }))
    with pytest.raises(PackageValidationError, match="duplicate or invalid"):
        compile_package_graph({"packages": [loss, output], "graph": _role_graph()})
