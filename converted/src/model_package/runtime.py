"""Inference runtime vendored into exported model wheels."""

from __future__ import annotations

import json
from importlib.resources import as_file, files

import torch
from safetensors.torch import load_file

from .adapters import InputAdapter, adapter_from_spec


class InferenceModel:
    """Public inference facade for the target-free prediction program."""

    def __init__(self, prediction: object, input_adapter: InputAdapter, adapters: object, device: torch.device) -> None:
        self._prediction = prediction
        self._adapters = adapters
        self.input_adapter = input_adapter
        self.device = device

    def adapter(self, name: str) -> object:
        """Return a declared wheel adapter by name."""

        return _WheelAdapterHandle(self._adapters.adapter(name), self.device)

    @torch.inference_mode()
    def predict_tensor(self, tensor: torch.Tensor) -> torch.Tensor:
        """Run the declared prediction program on a model-ready batch."""

        if not isinstance(tensor, torch.Tensor):
            raise TypeError("predict_tensor expects a torch.Tensor")
        return self._prediction(tensor.to(self.device))

    @torch.inference_mode()
    def predict(self, value: object) -> torch.Tensor:
        """Adapt one user-facing value and run prediction."""

        return self.predict_tensor(self.input_adapter.to_tensor(value))


class _WheelAdapterHandle:
    """Device-aware facade for one compiler-selected adapter."""

    def __init__(self, compiled: object, device: torch.device) -> None:
        self._compiled = compiled
        self._device = device

    @torch.inference_mode()
    def run(self, value: object) -> torch.Tensor:
        if isinstance(value, torch.Tensor):
            value = value.to(self._device)
        return self._compiled(value)


def load_model(device: str | torch.device = "cpu") -> InferenceModel:
    """Load the embedded package graph and shared trained state."""

    package_files = files(__package__)
    architecture = json.loads(package_files.joinpath("architecture.json").read_text(encoding="utf-8"))
    if architecture.get("schema_version") != 3 or architecture.get("format") != "package-model/v1":
        raise ValueError("unsupported model package schema")
    prediction = architecture.get("prediction")
    if not isinstance(prediction, dict) or prediction.get("program") != "prediction":
        raise ValueError("model package must declare the prediction program")

    from .package_runtime.compiler import compile_package_programs

    programs = compile_package_programs(architecture["package"])
    with as_file(package_files.joinpath("weights.safetensors")) as weights_path:
        state_dict = load_file(str(weights_path), device="cpu")
    programs.load_state_dict(state_dict, strict=True)
    programs.eval()
    target_device = torch.device(device)
    programs.to(target_device)
    declared_adapters = architecture.get("adapters", [])
    if not isinstance(declared_adapters, list):
        raise ValueError("model package adapters must be a list")
    compiled_adapters = programs.adapter_specs
    if declared_adapters != list(compiled_adapters):
        raise ValueError("model package adapter metadata does not match its package graph")
    return InferenceModel(programs.prediction, adapter_from_spec(architecture["input_adapter"]), programs, target_device)
