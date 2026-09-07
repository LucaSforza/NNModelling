"""Container entrypoint for compiling and training one package graph."""

from __future__ import annotations

import argparse
import json
import random
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import torch
from safetensors.torch import save_file

from backend.wandb_credentials import WandbCredentials, read_credentials_stdin
from package_runtime import CompiledPrograms, PackageValidationError, compile_package_graph
from dataset.contracts import DatasetDefinition, TensorSlotContract, TrainingBatch, normalize_training_batch
from training.datasets import resolve_dataset
from training.wandb_tracking import create_tracker, normalize_wandb_config


def run(
    input_path: Path,
    artifacts_path: Path,
    *,
    wandb_credentials: WandbCredentials | None = None,
) -> dict[str, Any]:
    """Compile the submitted graph and execute its declared training task."""

    request = json.loads(input_path.read_text(encoding="utf-8"))
    package = request.get("package")
    if not isinstance(package, dict):
        raise ValueError("package is required")
    training = _training_config(request)
    seed = _seed_from_training(training)
    _seed_everything(seed)
    dataset, definition, _reference, parameters = resolve_dataset(training)
    del dataset
    package = _materialize_dataset_inputs(package, definition, parameters)
    model = compile_package_graph(package)
    request = {**request, "package": package}
    summary = train(model, request, artifacts_path, wandb_credentials=wandb_credentials)
    artifacts_path.mkdir(parents=True, exist_ok=True)
    (artifacts_path / "package.json").write_text(json.dumps(package, sort_keys=True), encoding="utf-8")
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


def train(
    model: CompiledPrograms,
    request: dict[str, Any],
    artifacts_path: Path,
    *,
    wandb_credentials: WandbCredentials | None = None,
) -> dict[str, Any]:
    """Run the typed package training contract inside the worker."""

    training = _normalized_training(_training_config(request))
    _validate_training_support(training, wandb_credentials=wandb_credentials)
    dataset, definition, reference, parameters = resolve_dataset(training)
    _validate_graph_bindings(request.get("package", {}), definition)
    train_loader, validation_loader = _dataset_loaders(dataset)

    device = _training_device(training["trainer"]["accelerator"])
    model.to(device)
    _preflight_training_batch(model, request.get("package", {}), definition, train_loader, device)
    model.train()
    optimizer = _optimizer(model, training.get("optimizer", {}))
    max_epochs = max(1, int(training.get("trainer", {}).get("max_epochs", 1)))
    patience = int(training["trainer"].get("patience", 3))
    min_delta = float(training["trainer"].get("min_delta", 0.0))
    history: list[dict[str, float]] = []
    best_validation = float("inf")
    stale_epochs = 0
    tracker = create_tracker(
        training,
        request,
        artifacts_path,
        credentials=wandb_credentials,
    )

    try:
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
            epoch_number = epoch + 1
            history.append({"epoch": float(epoch_number), "train_loss": train_loss, "val_loss": validation_loss})
            tracker.log_epoch(epoch_number, train_loss, validation_loss)
            print(
                json.dumps({"epoch": epoch_number, "train_loss": train_loss, "val_loss": validation_loss}),
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
        tracker.finish(
            best_loss=best_validation,
            completed_epochs=len(history),
            num_parameters=summary["num_parameters"],
        )
        return summary
    except Exception:
        tracker.abort()
        raise


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
    result["wandb"] = normalize_wandb_config(raw.get("wandb"))
    if any(field in result for field in ("api_key", "credentials", "token", "password")):
        raise ValueError("training must not contain credentials")
    if "overrides" in result:
        raise ValueError("training.overrides is not part of the package training contract")
    return result


def _validate_training_support(
    training: dict[str, Any],
    *,
    wandb_credentials: WandbCredentials | None = None,
) -> None:
    mode = normalize_wandb_config(training.get("wandb"))["mode"]
    if mode == "online" and wandb_credentials is None:
        raise ValueError("online W&B logging requires credentials from stdin")
    if mode != "online" and wandb_credentials is not None:
        raise ValueError("W&B credentials are accepted only for online logging")
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
    """Reject semantic graph/dataset slot mismatches before the first epoch."""
    graph = package.get("graph") if isinstance(package, dict) else None
    if not isinstance(graph, dict):
        raise ValueError("package graph is required")
    nodes = graph.get("nodes", [])
    if not isinstance(nodes, list):
        raise ValueError("package graph nodes must be a list")
    nodes_by_id = {
        node["id"]: node
        for node in nodes
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    }
    if len(nodes_by_id) != len(nodes):
        raise ValueError("package graph contains invalid or duplicate nodes")
    input_bindings = graph.get("inputBindings", [])
    if not isinstance(input_bindings, list):
        raise ValueError("package graph inputBindings must be a list")
    for binding in input_bindings:
        if not isinstance(binding, dict) or not isinstance(binding.get("name"), str) or not isinstance(binding.get("nodeId"), str):
            raise ValueError("package graph contains an invalid input binding")
        name = binding["name"]
        if name not in definition.batch.inputs:
            raise ValueError(f"dataset is missing input slot: {name}")
        node = nodes_by_id.get(binding["nodeId"])
        if node is None:
            raise ValueError(f"input binding refers to missing graph node: {binding['nodeId']}")
        expected = _binding_tensor_contract(binding, f"input binding {name}")
        _compare_declared_contract(
            definition.batch.inputs[name], expected, f"input binding '{name}'"
        )
    objective_bindings = graph.get("objectiveBindings", [])
    if not isinstance(objective_bindings, list):
        raise ValueError("package graph objectiveBindings must be a list")
    for objective in objective_bindings:
        if not isinstance(objective, dict) or not isinstance(objective.get("nodeId"), str):
            raise ValueError("package graph contains an invalid objective binding")
        if objective["nodeId"] not in nodes_by_id:
            raise ValueError(f"objective binding refers to missing graph node: {objective['nodeId']}")
        external_inputs = objective.get("externalInputs", [])
        if not isinstance(external_inputs, list):
            raise ValueError("objective binding externalInputs must be a list")
        for binding in external_inputs:
            source = binding.get("source") if isinstance(binding, dict) else None
            if not isinstance(source, str) or not source.startswith("batch.targets."):
                raise ValueError("objective binding source is invalid")
            slot = source.removeprefix("batch.targets.")
            if slot not in definition.batch.targets:
                raise ValueError(f"dataset is missing target slot: {slot}")
            expected = _optional_binding_tensor_contract(binding, f"objective binding {slot}")
            if expected is not None:
                actual = _transformed_contract(definition.batch.targets[slot], binding.get("transform"))
                _compare_declared_contract(actual, expected, f"objective target '{slot}'")


def _materialize_dataset_inputs(
    package: Mapping[str, Any],
    definition: DatasetDefinition,
    parameters: Mapping[str, Any],
) -> dict[str, Any]:
    """Attach the resolved named Input contract before package compilation."""

    graph = package.get("graph")
    if not isinstance(graph, Mapping):
        raise ValueError("package graph is required")
    raw_bindings = graph.get("inputBindings")
    if not isinstance(raw_bindings, list) or not raw_bindings:
        raise ValueError("package graph requires resolved inputBindings")
    nodes = graph.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("package graph nodes must be a list")
    node_ids = {node.get("id") for node in nodes if isinstance(node, Mapping)}
    contracts: dict[str, dict[str, Any]] = {}
    bindings: list[dict[str, Any]] = []
    for raw in raw_bindings:
        if not isinstance(raw, Mapping):
            raise ValueError("package graph contains an invalid input binding")
        name, node_id = raw.get("name"), raw.get("nodeId")
        if not isinstance(name, str) or not name or not isinstance(node_id, str) or node_id not in node_ids:
            raise ValueError("package graph contains an invalid input binding")
        if name in contracts:
            raise ValueError(f"package graph has duplicate input binding: {name}")
        slot = definition.batch.inputs.get(name)
        if slot is None:
            raise ValueError(f"dataset is missing input slot: {name}")
        shape = _resolved_export_shape(slot.shape, parameters, f"batch.inputs.{name}")
        contract = {"type": "tensor", "shape": shape, "dtype": slot.dtype}
        contracts[name] = contract
        bindings.append({**dict(raw), "contract": contract})

    # Target dimensions are also part of the dataset-instantiated graph even
    # though they do not enter the prediction wheel.
    for name, slot in definition.batch.targets.items():
        _resolved_export_shape(slot.shape, parameters, f"batch.targets.{name}")

    previous = graph.get("inputContracts")
    if previous is not None and previous != contracts:
        raise ValueError("package graph input contract does not match the selected dataset")
    materialized_graph = {**dict(graph), "inputBindings": bindings, "inputContracts": contracts}
    return {**dict(package), "graph": materialized_graph}


def _resolved_export_shape(
    shape: tuple[str | int, ...],
    parameters: Mapping[str, Any],
    label: str,
) -> list[str | int]:
    """Resolve symbols and preserve only the protocol's dynamic batch axis."""

    resolved: list[str | int] = []
    for index, dimension in enumerate(shape):
        if isinstance(dimension, int):
            resolved.append("B" if index == 0 else dimension)
            continue
        value = parameters.get(dimension)
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"{label}.shape[{index}] symbol '{dimension}' must resolve to a positive integer")
        resolved.append("B" if index == 0 else value)
    return resolved


def _binding_tensor_contract(binding: Mapping[str, Any], label: str) -> TensorSlotContract:
    """Read a resolved tensor contract from semantic bundle metadata."""
    contract = _optional_binding_tensor_contract(binding, label)
    if contract is None:
        raise ValueError(f"{label} is missing a resolved tensor contract")
    return contract


def _optional_binding_tensor_contract(binding: Any, label: str) -> TensorSlotContract | None:
    if not isinstance(binding, Mapping):
        raise ValueError(f"{label} is invalid")
    candidate = binding.get("contract")
    if candidate is None:
        candidate = binding if "shape" in binding or "dtype" in binding else None
    if candidate is None:
        return None
    if not isinstance(candidate, Mapping):
        raise ValueError(f"{label} tensor metadata is invalid")
    try:
        return TensorSlotContract(shape=tuple(candidate["shape"]), dtype=candidate["dtype"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"{label} tensor metadata is invalid") from exc


def _compare_declared_contract(actual: TensorSlotContract, expected: TensorSlotContract, label: str) -> None:
    if actual.dtype != expected.dtype:
        raise ValueError(f"{label} has incompatible dtype: dataset declares {actual.dtype}, graph requires {expected.dtype}")
    if not _shapes_compatible(actual.shape, expected.shape):
        raise ValueError(f"{label} has incompatible shape: dataset declares {list(actual.shape)}, graph requires {list(expected.shape)}")


def _shapes_compatible(actual: tuple[str | int, ...], expected: tuple[str | int, ...]) -> bool:
    if len(actual) != len(expected):
        return False
    symbols: dict[str, str | int] = {}
    for index, (actual_dimension, expected_dimension) in enumerate(zip(actual, expected)):
        if index == 0 and (actual_dimension == "B" or expected_dimension == "B"):
            continue
        if isinstance(actual_dimension, int) and isinstance(expected_dimension, int):
            if actual_dimension != expected_dimension:
                return False
            continue
        if isinstance(actual_dimension, str):
            previous = symbols.get(actual_dimension)
            if previous is not None and previous != expected_dimension:
                return False
            symbols[actual_dimension] = expected_dimension
    return True


def _transformed_contract(contract: TensorSlotContract, transform: Any) -> TensorSlotContract:
    if transform is None:
        return contract
    if transform != "flatten_batch":
        raise ValueError(f"unsupported objective binding transform: {transform!r}")
    if len(contract.shape) <= 1:
        return contract
    dimensions = contract.shape[1:]
    if all(isinstance(dimension, int) for dimension in dimensions):
        flattened: str | int = 1
        for dimension in dimensions:
            flattened *= dimension
    else:
        flattened = "flattened"
    return TensorSlotContract(shape=(contract.shape[0], flattened), dtype=contract.dtype)


def _preflight_training_batch(
    model: CompiledPrograms,
    package: Any,
    definition: DatasetDefinition,
    loader: Any,
    device: torch.device,
) -> None:
    """Exercise one normalized batch and its declared objective before epoch one."""
    try:
        raw_batch = next(iter(loader))
    except StopIteration:
        return
    batch = normalize_training_batch(raw_batch).to(device)
    _validate_batch_contract(batch, definition)
    try:
        with torch.no_grad():
            loss = model.objective(batch.inputs, batch.targets)
    except PackageValidationError:
        raise
    except Exception as exc:
        raise ValueError("objective bindings are incompatible with the dataset batch") from exc
    if not isinstance(loss, torch.Tensor) or loss.ndim != 0:
        raise ValueError("package objective must return a scalar tensor")


def _validate_batch_contract(batch: TrainingBatch, definition: DatasetDefinition) -> None:
    for group_name, tensors, contracts in (
        ("inputs", batch.inputs, definition.batch.inputs),
        ("targets", batch.targets, definition.batch.targets),
    ):
        if set(tensors) != set(contracts):
            raise ValueError(f"dataset batch {group_name} slots do not match its declared contract")
        for name, tensor in tensors.items():
            contract = contracts[name]
            if _tensor_shape_mismatch(tuple(tensor.shape), contract.shape):
                raise ValueError(f"dataset batch {group_name}.{name} has incompatible shape")
            expected_dtype = getattr(torch, contract.dtype)
            if tensor.dtype != expected_dtype:
                raise ValueError(f"dataset batch {group_name}.{name} has incompatible dtype: {tensor.dtype} != {contract.dtype}")


def _tensor_shape_mismatch(actual: tuple[int, ...], expected: tuple[str | int, ...]) -> bool:
    if len(actual) != len(expected):
        return True
    symbols: dict[str, int] = {}
    for index, (actual_dimension, expected_dimension) in enumerate(zip(actual, expected)):
        if index == 0 and isinstance(expected_dimension, str):
            continue
        if isinstance(expected_dimension, int) and actual_dimension != expected_dimension:
            return True
        if isinstance(expected_dimension, str):
            previous = symbols.get(expected_dimension)
            if previous is not None and previous != actual_dimension:
                return True
            symbols[expected_dimension] = actual_dimension
    return False


def _dataset_loaders(dataset: Any) -> tuple[Any, Any]:
    division = dataset.division()
    required = {"train", "validation", "test"}
    if not isinstance(division, Mapping) or set(division) != required:
        raise ValueError("dataset division must provide exactly train, validation, and test loaders")
    return division["train"], division["validation"]


def main() -> None:
    """Parse the immutable container contract."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument(
        "--wandb-credentials-stdin",
        action="store_true",
        help="read the bounded administrator credential JSON from stdin before compilation",
    )
    args = parser.parse_args()
    credentials = None
    if args.wandb_credentials_stdin:
        stream = getattr(sys.stdin, "buffer", sys.stdin)
        try:
            credentials = read_credentials_stdin(stream)
        finally:
            sys.stdin.close()
    print(json.dumps(run(args.input, args.artifacts, wandb_credentials=credentials), sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
