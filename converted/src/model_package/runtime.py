"""Inference runtime vendored into exported model wheels."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from importlib.resources import as_file, files
from pathlib import Path

import torch
from safetensors import safe_open

from .adapters import InputAdapter, adapter_from_spec


ARCHITECTURE_FINGERPRINT = "nnm_architecture_fingerprint"


class Model:
    """Public inference facade for the target-free prediction program."""

    def __init__(
        self,
        weights: str | Path | None = None,
        *,
        device: str | torch.device = "cpu",
    ) -> None:
        """Load the packaged model, optionally replacing its local weights."""

        package_files = files(__package__)
        architecture = _load_architecture(package_files.joinpath("architecture.json"))
        target_device = torch.device(device)
        from .package_runtime.compiler import compile_package_programs

        programs = compile_package_programs(architecture["package"])
        embedded_weights = package_files.joinpath("weights.safetensors")
        if weights is None:
            with as_file(embedded_weights) as weights_path:
                state_dict = _load_verified_state(Path(weights_path), programs, architecture)
        else:
            state_dict = _load_verified_state(Path(weights), programs, architecture)
        programs.load_state_dict(state_dict, strict=True)
        programs.eval()
        programs.to(target_device)
        declared_adapters = architecture.get("adapters", [])
        if not isinstance(declared_adapters, list):
            raise ValueError("model package adapters must be a list")
        compiled_adapters = programs.adapter_specs
        if declared_adapters != list(compiled_adapters):
            raise ValueError("model package adapter metadata does not match its package graph")
        self._prediction = programs.prediction
        self._adapters = programs
        self.input_adapter = adapter_from_spec(architecture["input_adapter"])
        contract = architecture.get("input_contract")
        if not isinstance(contract, Mapping):
            raise ValueError("model package input contract is missing")
        inputs = contract.get("inputs")
        if not isinstance(inputs, Mapping):
            raise ValueError("model package input contract must contain named inputs")
        self._input_contract = {str(name): dict(schema) for name, schema in inputs.items()}
        self.device = target_device

    def adapter(self, name: str) -> object:
        """Return a declared wheel adapter by name."""

        return _WheelAdapterHandle(self._adapters.adapter(name), self.device)

    @torch.inference_mode()
    def predict_tensor(self, tensor: torch.Tensor | Mapping[str, torch.Tensor]) -> torch.Tensor:
        """Run the declared prediction program on a model-ready batch."""

        inputs = _validated_inputs(tensor, self._input_contract, self.device)
        return self._prediction(inputs)

    @torch.inference_mode()
    def predict(self, value: object) -> torch.Tensor:
        """Adapt one user-facing value and run prediction."""

        if self._input_contract and len(self._input_contract) != 1:
            raise TypeError("predict requires exactly one named input; use predict_tensor with a tensor map")
        return self.predict_tensor(self.input_adapter.to_tensor(value))


InferenceModel = Model


def load_model(device: str | torch.device = "cpu") -> Model:
    """Load the embedded package graph and shared trained state."""

    return Model(device=device)


def _load_architecture(path: object) -> dict[str, object]:
    """Load and validate the immutable architecture descriptor."""

    architecture = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(architecture, dict):
        raise ValueError("model package architecture must be an object")
    if architecture.get("schema_version") != 3 or architecture.get("format") != "package-model/v1":
        raise ValueError("unsupported model package schema")
    prediction = architecture.get("prediction")
    if not isinstance(prediction, dict) or prediction.get("program") != "prediction":
        raise ValueError("model package must declare the prediction program")
    fingerprint = architecture.get("architecture_fingerprint")
    if not isinstance(fingerprint, str) or not fingerprint:
        raise ValueError("model package architecture fingerprint is missing")
    if fingerprint != _architecture_fingerprint(architecture):
        raise ValueError("model package architecture fingerprint is invalid")
    if not isinstance(architecture.get("package"), Mapping):
        raise ValueError("model package must contain a package graph")
    input_adapter = architecture.get("input_adapter")
    if not isinstance(input_adapter, Mapping):
        raise ValueError("model package input adapter must be an object")
    input_contract = architecture.get("input_contract")
    if not isinstance(input_contract, Mapping) or not isinstance(input_contract.get("inputs"), Mapping):
        raise ValueError("model package input contract is missing")
    return architecture


def _validated_inputs(
    value: torch.Tensor | Mapping[str, torch.Tensor],
    contract: Mapping[str, Mapping[str, object]],
    device: torch.device,
) -> torch.Tensor | dict[str, torch.Tensor]:
    """Validate named input tensors while keeping only the leading batch dynamic."""

    if isinstance(value, torch.Tensor):
        if not contract:
            return value.to(device)
        if len(contract) != 1:
            raise TypeError("multiple named inputs require a tensor map")
        name, schema = next(iter(contract.items()))
        tensor = value.to(device)
        _validate_tensor(tensor, schema, name)
        return tensor
    if not isinstance(value, Mapping):
        raise TypeError("predict_tensor expects a torch.Tensor or named tensor map")
    if set(value) != set(contract):
        missing = sorted(set(contract) - set(value))
        extra = sorted(set(value) - set(contract))
        raise ValueError(f"named input map mismatch (missing={missing}, extra={extra})")
    validated: dict[str, torch.Tensor] = {}
    for name, schema in contract.items():
        tensor = value[name]
        if not isinstance(tensor, torch.Tensor):
            raise TypeError(f"input {name!r} must be a torch.Tensor")
        tensor = tensor.to(device)
        _validate_tensor(tensor, schema, name)
        validated[name] = tensor
    return validated


def _validate_tensor(tensor: torch.Tensor, schema: Mapping[str, object], name: str) -> None:
    shape = schema.get("shape")
    dtype_name = schema.get("dtype")
    if not isinstance(shape, list) or not isinstance(dtype_name, str):
        raise ValueError(f"input contract {name!r} is invalid")
    expected_dtype = getattr(torch, dtype_name, None)
    if tensor.dtype != expected_dtype:
        raise TypeError(f"input {name!r} dtype {tensor.dtype} does not match {dtype_name}")
    if tensor.ndim != len(shape):
        raise ValueError(f"input {name!r} rank {tensor.ndim} does not match declared rank {len(shape)}")
    for index, dimension in enumerate(shape):
        if dimension == "B" and index == 0:
            continue
        if not isinstance(dimension, int) or tensor.shape[index] != dimension:
            raise ValueError(f"input {name!r} dimension {index} does not match declared contract")


def _architecture_fingerprint(architecture: Mapping[str, object]) -> str:
    """Hash architecture metadata without recursively hashing its own digest."""

    payload = {key: value for key, value in architecture.items() if key != "architecture_fingerprint"}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _load_verified_state(
    weights_path: Path, programs: torch.nn.Module, architecture: Mapping[str, object]
) -> dict[str, torch.Tensor]:
    """Read safetensors and validate metadata and state tensors before loading."""

    if not weights_path.is_file():
        raise FileNotFoundError(f"model weights not found: {weights_path}")
    expected_fingerprint = architecture["architecture_fingerprint"]
    with safe_open(str(weights_path), framework="pt") as handle:
        metadata = handle.metadata() or {}
        if metadata.get(ARCHITECTURE_FINGERPRINT) != expected_fingerprint:
            raise ValueError("model weights are missing or have a mismatched architecture fingerprint")
        state_dict = {name: handle.get_tensor(name) for name in handle.keys()}
    expected_state = programs.state_dict()
    actual_keys = set(state_dict)
    expected_keys = set(expected_state)
    if actual_keys != expected_keys:
        missing = sorted(expected_keys - actual_keys)
        extra = sorted(actual_keys - expected_keys)
        raise ValueError(f"model weights state-dict keys mismatch (missing={missing}, extra={extra})")
    for name in sorted(expected_keys):
        expected, actual = expected_state[name], state_dict[name]
        if actual.shape != expected.shape:
            raise ValueError(
                f"model weight {name!r} shape mismatch: got {tuple(actual.shape)}, expected {tuple(expected.shape)}"
            )
        if actual.dtype != expected.dtype:
            raise ValueError(f"model weight {name!r} dtype mismatch: got {actual.dtype}, expected {expected.dtype}")
    return state_dict


class _WheelAdapterHandle:
    """Device-aware facade for one compiler-selected adapter."""

    def __init__(self, compiled: object, device: torch.device) -> None:
        self._device = device
        self._compiled = compiled

    @torch.inference_mode()
    def run(self, value: object) -> torch.Tensor:
        if isinstance(value, torch.Tensor):
            value = value.to(self._device)
        return self._compiled(value)
