"""Container entrypoint for compiling and training one package graph."""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Any

import torch
from safetensors.torch import save_file

from package_runtime import CompiledPrograms, compile_package_graph
from dataset.contracts import DatasetDefinition, normalize_training_batch
from training.datasets import resolve_dataset


def run(input_path: Path, artifacts_path: Path) -> dict[str, Any]:
    """Compile the submitted graph and execute its declared training task."""

    request = json.loads(input_path.read_text(encoding="utf-8"))
    package = request.get("package")
    if not isinstance(package, dict):
        raise ValueError("package is required")
    training = _training_config(request)
    seed = _seed_from_training(training)
    _seed_everything(seed)
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
    return result


def train(model: CompiledPrograms, request: dict[str, Any], artifacts_path: Path) -> dict[str, Any]:
    """Run the typed package training contract inside the worker."""

    training = _normalized_training(_training_config(request))
    _validate_training_support(training)
    dataset, definition, reference, parameters = resolve_dataset(training)
    _validate_graph_bindings(request.get("package", {}), definition)
    train_loader, validation_loader = _dataset_loaders(dataset)

    device = _training_device(training["trainer"]["accelerator"])
    model.to(device)
    model.train()
    optimizer = _optimizer(model, training.get("optimizer", {}))
    max_epochs = max(1, int(training.get("trainer", {}).get("max_epochs", 1)))
    patience = int(training["trainer"].get("patience", 3))
    min_delta = float(training["trainer"].get("min_delta", 0.0))
    history: list[dict[str, float]] = []
    best_validation = float("inf")
    stale_epochs = 0

    for epoch in range(max_epochs):
        total = 0.0
        batches = 0
        for raw_batch in train_loader:
            batch = normalize_training_batch(raw_batch).to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = model.objective(batch.inputs, batch.targets)
            if not torch.isfinite(loss):
                raise RuntimeError("package training produced a non-finite loss")
            loss.backward()
            optimizer.step()
            total += float(loss.detach())
            batches += 1
        train_loss = total / max(1, batches)
        validation_loss = _evaluate(model, validation_loader, device)
        history.append({"epoch": float(epoch + 1), "train_loss": train_loss, "val_loss": validation_loss})
        print(
            json.dumps({"epoch": epoch + 1, "train_loss": train_loss, "val_loss": validation_loss}),
            flush=True,
        )
        if validation_loss < best_validation - min_delta:
            best_validation = validation_loss
            stale_epochs = 0
        else:
            stale_epochs += 1
            if stale_epochs > patience:
                break

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
        "dataset": {"reference": reference.model_dump(mode="json"), "parameters": parameters},
        "epochs": len(history),
        "history": history,
        "config": training,
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


def _seed_from_training(training: dict[str, Any]) -> int:
    value = training.get("seed", 0)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("training.seed must be a non-negative integer")
    return value


def _seed_everything(seed: int) -> None:
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True, warn_only=True)


def _normalized_training(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize the public request without duplicating dataset settings."""
    if not isinstance(raw, dict):
        raise ValueError("training must be an object")
    dataset = raw.get("dataset")
    if not isinstance(dataset, dict) or not isinstance(dataset.get("reference"), dict):
        raise ValueError("training.dataset.reference is required")
    parameters = dict(dataset.get("parameters", {}))
    if any(name in raw for name in ("batch_size", "num_workers", "train_size")):
        raise ValueError("loader settings belong in training.dataset.parameters")
    result = dict(raw)
    result["dataset"] = {"reference": dict(dataset["reference"]), "parameters": parameters}
    result["optimizer"] = dict(raw.get("optimizer", {}))
    result["trainer"] = dict(raw.get("trainer", {}))
    result["trainer"].setdefault("max_epochs", 20)
    result["trainer"].setdefault("accelerator", "auto")
    result["trainer"].setdefault("patience", 3)
    result["trainer"].setdefault("min_delta", 0.0)
    result.setdefault("seed", 0)
    result.setdefault("wandb", {"mode": "disabled", "project": "NeuralNetworks"})
    if "overrides" in result:
        raise ValueError("training.overrides is not part of the package training contract")
    return result


def _validate_training_support(training: dict[str, Any]) -> None:
    wandb = training.get("wandb", {})
    if isinstance(wandb, dict) and wandb.get("mode", "disabled") != "disabled":
        raise ValueError("W&B logging is not available in the package worker")
    _seed_from_training(training)
    trainer = training["trainer"]
    accelerator = trainer.get("accelerator", "auto")
    if accelerator not in {"auto", "cpu", "cuda"}:
        raise ValueError(f"unsupported accelerator: {accelerator}")


def _training_device(accelerator: str) -> torch.device:
    if accelerator == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA accelerator requested but no CUDA device is available")
    return torch.device("cuda" if accelerator == "cuda" else "cpu")


def _optimizer(model: torch.nn.Module, config: Any) -> torch.optim.Optimizer:
    config = config if isinstance(config, dict) else {}
    name = str(config.get("target", "Adam")).rsplit(".", 1)[-1]
    optimizer_class = getattr(torch.optim, name, None)
    if optimizer_class not in {torch.optim.Adam, torch.optim.SGD, torch.optim.AdamW}:
        raise ValueError(f"unsupported optimizer: {name}")
    learning_rate = float(config.get("learning_rate", 1e-3))
    return optimizer_class(model.parameters(), lr=learning_rate)


@torch.no_grad()
def _evaluate(model: CompiledPrograms, loader: Any, device: torch.device) -> float:
    model.eval()
    total = 0.0
    batches = 0
    for raw_batch in loader:
        batch = normalize_training_batch(raw_batch).to(device)
        total += float(model.objective(batch.inputs, batch.targets))
        batches += 1
    model.train()
    return total / max(1, batches)


def _validate_graph_bindings(package: Any, definition: DatasetDefinition) -> None:
    """Reject graph/dataset slot mismatches before the first epoch."""
    graph = package.get("graph") if isinstance(package, dict) else None
    if not isinstance(graph, dict):
        raise ValueError("package graph is required")
    input_bindings = graph.get("inputBindings", [])
    if not isinstance(input_bindings, list):
        raise ValueError("package graph inputBindings must be a list")
    for binding in input_bindings:
        if not isinstance(binding, dict) or not isinstance(binding.get("name"), str):
            raise ValueError("package graph contains an invalid input binding")
        if binding["name"] not in definition.batch.inputs:
            raise ValueError(f"dataset is missing input slot: {binding['name']}")
    objective_bindings = graph.get("objectiveBindings", [])
    if not isinstance(objective_bindings, list):
        raise ValueError("package graph objectiveBindings must be a list")
    for objective in objective_bindings:
        if not isinstance(objective, dict):
            raise ValueError("package graph contains an invalid objective binding")
        for binding in objective.get("externalInputs", []):
            source = binding.get("source") if isinstance(binding, dict) else None
            if not isinstance(source, str) or not source.startswith("batch.targets."):
                raise ValueError("objective binding source is invalid")
            slot = source.removeprefix("batch.targets.")
            if slot not in definition.batch.targets:
                raise ValueError(f"dataset is missing target slot: {slot}")


def _dataset_loaders(dataset: Any) -> tuple[Any, Any]:
    division = dataset.division()
    if isinstance(division, dict):
        try:
            return division["train"], division["validation"]
        except KeyError as exc:
            raise ValueError("dataset division must provide train and validation loaders") from exc
    if isinstance(division, tuple) and len(division) >= 2:
        return division[0], division[1]
    raise ValueError("dataset division must provide named train and validation loaders")


def main() -> None:
    """Parse the immutable container contract."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.input, args.artifacts), sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
