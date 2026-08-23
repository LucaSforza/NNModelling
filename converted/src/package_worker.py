"""Container entrypoint for compiling and training one package graph."""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.util
import inspect
import json
import random
import zipfile
from pathlib import Path
from typing import Any

import torch
from safetensors.torch import save_file

from package_runtime import compile_package_graph


def run(input_path: Path, artifacts_path: Path) -> dict[str, Any]:
    """Compile the submitted graph and execute its declared training task."""

    request = json.loads(input_path.read_text(encoding="utf-8"))
    package = request.get("package")
    if not isinstance(package, dict):
        return _run_legacy(request, input_path.parent, artifacts_path)
    model = compile_package_graph(package)
    summary = train(model, request, artifacts_path)
    result = {
        "schema_version": 1,
        "format": "package-training-result/v1",
        "packages": [
            {"id": item["manifest"]["id"], "version": item["manifest"]["version"]}
            for item in package["packages"]
        ],
        "training": summary,
    }
    artifacts_path.mkdir(parents=True, exist_ok=True)
    (artifacts_path / "package-worker-result.json").write_text(
        json.dumps(result, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    _write_trained_package(package, artifacts_path)
    return result


def _run_legacy(request: dict[str, Any], package_root: Path, artifacts_path: Path) -> dict[str, Any]:
    """Keep the old path working while NNTree/container callers migrate."""

    packages = request.get("packages", [])
    if not isinstance(packages, list):
        raise TypeError("packages must be a list")
    loaded = [_load_legacy_package(package_root, package) for package in packages]
    by_identity = {f"{item['id']}@{item['version']}": item for item in loaded}
    builds = []
    for invocation in request.get("builds", []):
        identity = str(invocation["package"])
        package = by_identity.get(identity)
        if package is None:
            raise ValueError(f"build references undeclared package: {identity}")
        module = package["build"](
            invocation.get("parameters", {}),
            invocation.get("context", {"inputs": [], "output": {}}),
            invocation.get("services", {}),
        )
        builds.append({"package": identity, "module": type(module).__name__})
    result = {
        "schema_version": 1,
        "packages": [{"id": item["id"], "version": item["version"]} for item in loaded],
        "builds": builds,
    }
    artifacts_path.mkdir(parents=True, exist_ok=True)
    (artifacts_path / "package-worker-result.json").write_text(
        json.dumps(result, indent=2), encoding="utf-8"
    )
    return result


def _load_legacy_package(package_root: Path, package: dict[str, Any]) -> dict[str, Any]:
    """Load the pre-bundle worker fixture used by the compatibility test."""

    package_id = str(package["id"])
    version = str(package["version"])
    root = (package_root / str(package.get("path", f"packages/{package_id}/{version}"))).resolve()
    if package_root.resolve() not in root.parents and root != package_root.resolve():
        raise ValueError("package path escapes input root")
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("id") != package_id or manifest.get("version") != version:
        raise ValueError("package identity mismatch")
    entrypoint = root / str(package.get("entrypoint", "pytorch.py"))
    module_name = "nnm_legacy_" + hashlib.sha256(f"{package_id}@{version}".encode()).hexdigest()[:16]
    spec = importlib.util.spec_from_file_location(module_name, entrypoint)
    if spec is None or spec.loader is None:
        raise ImportError("cannot load package entrypoint")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    build = getattr(module, "build", None)
    if not callable(build):
        raise TypeError("package entrypoint must export build")
    return {"id": package_id, "version": version, "build": build}


def train(model: torch.nn.Module, request: dict[str, Any], artifacts_path: Path) -> dict[str, Any]:
    """Run a small, deterministic PyTorch loop using the registered dataset."""

    training = _training_config(request)
    dataset_config = training.get("dataset", {})
    target = str(dataset_config.get("target", "dataset.autoencoder_mnist.AutoencoderMNIST"))
    dataset_class = _load_dataset_class(target)
    dataset = dataset_class(**_dataset_parameters(dataset_class, dataset_config.get("parameters", {})))
    train_loader, validation_loader, _ = dataset.division()

    seed = int(training.get("seed", 0))
    random.seed(seed)
    torch.manual_seed(seed)
    torch.set_num_threads(max(1, min(4, torch.get_num_threads())))
    model.train()
    optimizer = _optimizer(model, training.get("optimizer", {}))
    max_epochs = max(1, int(training.get("trainer", {}).get("max_epochs", 1)))
    history: list[dict[str, float]] = []

    for epoch in range(max_epochs):
        total = 0.0
        batches = 0
        for inputs, targets in train_loader:
            optimizer.zero_grad(set_to_none=True)
            outputs = model(inputs, targets)
            loss = _loss(outputs, targets)
            if not torch.isfinite(loss):
                raise RuntimeError("package training produced a non-finite loss")
            loss.backward()
            optimizer.step()
            total += float(loss.detach())
            batches += 1
        train_loss = total / max(1, batches)
        validation_loss = _evaluate(model, validation_loader)
        history.append({"epoch": float(epoch + 1), "train_loss": train_loss, "val_loss": validation_loss})
        print(
            json.dumps({"epoch": epoch + 1, "train_loss": train_loss, "val_loss": validation_loss}),
            flush=True,
        )

    artifacts_path.mkdir(parents=True, exist_ok=True)
    tensors = {
        key: value.detach().cpu()
        for key, value in model.state_dict().items()
        if isinstance(value, torch.Tensor)
    }
    if not tensors:
        raise RuntimeError("compiled package graph has no trainable state")
    save_file(tensors, str(artifacts_path / "weights.safetensors"))
    summary = {
        "dataset": target,
        "epochs": max_epochs,
        "history": history,
        "num_parameters": sum(parameter.numel() for parameter in model.parameters()),
    }
    (artifacts_path / "training-summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return summary


def _training_config(request: dict[str, Any]) -> dict[str, Any]:
    """Read training options from both direct and backend job envelopes."""

    direct = request.get("training")
    if isinstance(direct, dict):
        return direct
    submission = request.get("submission")
    if isinstance(submission, dict) and isinstance(submission.get("training"), dict):
        return submission["training"]
    return {}


def _write_trained_package(package: dict[str, Any], artifacts_path: Path) -> dict[str, Any]:
    """Bundle the exact graph resources and trained weights for inference."""

    archive_path = artifacts_path / "trained-package.zip"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "package.json",
            json.dumps(package, indent=2, sort_keys=True),
        )
        for name in ("weights.safetensors", "training-summary.json", "package-worker-result.json"):
            archive.write(artifacts_path / name, name)
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    return {
        "schema_version": 1,
        "format": "nnm-trained-package/v1",
        "filename": archive_path.name,
        "sha256": digest,
        "size": archive_path.stat().st_size,
    }


def _load_dataset_class(target: str) -> type[Any]:
    if not target.startswith("dataset.") or target.count(".") < 2:
        raise ValueError("dataset target must be a trusted dataset module")
    module_name, class_name = target.rsplit(".", 1)
    module = importlib.import_module(module_name)
    candidate = getattr(module, class_name, None)
    if not inspect.isclass(candidate):
        raise ValueError(f"unknown dataset target: {target}")
    return candidate


def _dataset_parameters(dataset_class: type[Any], raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("dataset parameters must be an object")
    result: dict[str, Any] = {}
    for name, parameter in inspect.signature(dataset_class).parameters.items():
        if name not in raw or raw[name] in (None, ""):
            continue
        value = raw[name]
        default = parameter.default
        try:
            if isinstance(default, bool):
                value = str(value).lower() == "true"
            elif isinstance(default, int):
                value = int(value)
            elif isinstance(default, float):
                value = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"invalid dataset parameter {name}") from exc
        result[name] = value
    return result


def _optimizer(model: torch.nn.Module, config: Any) -> torch.optim.Optimizer:
    config = config if isinstance(config, dict) else {}
    name = str(config.get("target", "Adam")).rsplit(".", 1)[-1]
    optimizer_class = getattr(torch.optim, name, None)
    if optimizer_class not in {torch.optim.Adam, torch.optim.SGD, torch.optim.AdamW}:
        raise ValueError(f"unsupported optimizer: {name}")
    learning_rate = float(config.get("learning_rate", 1e-3))
    return optimizer_class(model.parameters(), lr=learning_rate)


def _loss(outputs: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
    if outputs.ndim == 0:
        return outputs
    if outputs.shape == targets.shape:
        return torch.nn.functional.mse_loss(outputs, targets)
    if targets.dtype in (torch.int64, torch.long) and outputs.ndim == 2:
        return torch.nn.functional.cross_entropy(outputs, targets)
    raise ValueError(f"model output shape {tuple(outputs.shape)} does not match target {tuple(targets.shape)}")


@torch.no_grad()
def _evaluate(model: torch.nn.Module, loader: Any) -> float:
    model.eval()
    total = 0.0
    batches = 0
    for inputs, targets in loader:
        total += float(_loss(model(inputs, targets), targets))
        batches += 1
    model.train()
    return total / max(1, batches)


def main() -> None:
    """Parse the immutable container contract."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.input, args.artifacts), sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
