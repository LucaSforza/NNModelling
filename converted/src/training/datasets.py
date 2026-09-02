"""Resolve the v2 dataset contract inside the isolated package worker."""

from __future__ import annotations

import importlib.util
import json
import os
from collections.abc import Mapping
from pathlib import Path
from types import ModuleType
from typing import Any

from dataset.contracts import DatasetContext, DatasetDefinition, DatasetReference


def resolve_dataset(request: Mapping[str, Any]) -> tuple[Any, DatasetDefinition, DatasetReference, dict[str, Any]]:
    """Build one immutable dataset reference without accepting import targets."""
    raw = request.get("dataset")
    if not isinstance(raw, Mapping):
        raise ValueError("training.dataset is required")
    reference = DatasetReference.model_validate(raw.get("reference"))
    parameters = raw.get("parameters", {})
    if not isinstance(parameters, Mapping):
        raise ValueError("training.dataset.parameters must be an object")
    root = _resource_root()
    definition = DatasetDefinition.model_validate(json.loads((root / "dataset.json").read_text(encoding="utf-8")))
    if (definition.id, definition.version) != (reference.id, reference.version):
        raise ValueError("project dataset definition does not match its opaque reference")
    normalized = _project_parameters(definition, parameters)
    module = _load_project_module(root / "dataset.py")
    builder = getattr(module, "build", None)
    if not callable(builder):
        raise ValueError("project dataset must export build(parameters, context)")
    dataset = builder(normalized, DatasetContext(root, reference))
    return dataset, definition, reference, normalized


def _resource_root() -> Path:
    value = os.environ.get("NNM_DATASET_ROOT")
    if not value:
        raise ValueError("NNM_DATASET_ROOT is not configured")
    root = Path(value).resolve()
    if not root.is_dir():
        raise ValueError("dataset resource root is unavailable")
    return root


def _project_parameters(definition: DatasetDefinition, raw: Mapping[str, Any]) -> dict[str, Any]:
    names = {parameter.name for parameter in definition.parameters}
    unknown = sorted(set(raw) - names)
    if unknown:
        raise ValueError(f"unknown dataset parameter(s): {', '.join(unknown)}")
    result: dict[str, Any] = {}
    for parameter in definition.parameters:
        if parameter.name not in raw:
            if parameter.required:
                raise ValueError(f"missing required dataset parameter: {parameter.name}")
            if parameter.default is not None:
                result[parameter.name] = parameter.default
            continue
        value = raw[parameter.name]
        if parameter.type == "string" and not isinstance(value, str):
            raise ValueError(f"invalid dataset parameter {parameter.name}")
        if parameter.type == "integer" and (isinstance(value, bool) or not isinstance(value, int)):
            raise ValueError(f"invalid dataset parameter {parameter.name}")
        if parameter.type == "number" and (isinstance(value, bool) or not isinstance(value, (int, float))):
            raise ValueError(f"invalid dataset parameter {parameter.name}")
        if parameter.type == "boolean" and not isinstance(value, bool):
            raise ValueError(f"invalid dataset parameter {parameter.name}")
        result[parameter.name] = value
    return result


def _load_project_module(path: Path) -> ModuleType:
    if not path.is_file():
        raise ValueError("project dataset code is unavailable")
    spec = importlib.util.spec_from_file_location("nnm_project_dataset", path)
    if spec is None or spec.loader is None:
        raise ValueError("project dataset code cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
