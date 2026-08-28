"""Discover dataset classes installed in the backend Python environment."""

from __future__ import annotations

import inspect
import importlib
import pkgutil
from types import UnionType
from typing import Any, get_args, get_origin, get_type_hints

from dataset.ds import Dataset

from backend.models import DatasetInfo, DatasetParameter


def _type_name(annotation: Any) -> str:
    """Return a stable display name for a constructor annotation."""

    if annotation is inspect.Parameter.empty:
        return "string"
    if annotation in (str, int, float, bool):
        return annotation.__name__
    return str(annotation).replace("typing.", "")


def discover_datasets() -> list[DatasetInfo]:
    """Find concrete ``Dataset`` subclasses in the trusted dataset package."""

    import dataset

    result: list[DatasetInfo] = []
    module_names = [dataset.__name__]
    if hasattr(dataset, "__path__"):
        module_names.extend(
            f"{dataset.__name__}.{module.name}"
            for module in pkgutil.iter_modules(dataset.__path__)
        )

    seen: set[str] = set()
    for module_name in module_names:
        module = importlib.import_module(module_name)
        for class_name, candidate in inspect.getmembers(module, inspect.isclass):
            if candidate is Dataset or not issubclass(candidate, Dataset):
                continue
            target = f"{candidate.__module__}.{class_name}"
            if target in seen:
                continue
            seen.add(target)
            try:
                signature = inspect.signature(candidate.__init__)
                hints = get_type_hints(candidate.__init__)
            except (TypeError, ValueError):
                signature = None
                hints = {}
            parameters: list[DatasetParameter] = []
            if signature:
                for name, parameter in signature.parameters.items():
                    if name == "self" or parameter.kind in (
                        inspect.Parameter.VAR_POSITIONAL,
                        inspect.Parameter.VAR_KEYWORD,
                    ):
                        continue
                    default = None if parameter.default is inspect.Parameter.empty else parameter.default
                    try:
                        # The API must remain JSON serializable.
                        import json

                        json.dumps(default)
                    except (TypeError, ValueError):
                        default = str(default)
                    parameters.append(
                        DatasetParameter(
                            name=name,
                            type=_type_name(hints.get(name, parameter.annotation)),
                            default=default,
                            required=parameter.default is inspect.Parameter.empty,
                        )
                    )
            result.append(
                DatasetInfo(
                    target=target,
                    name=class_name,
                    doc=inspect.getdoc(candidate) or "",
                    parameters=parameters,
                    num_classes=_num_classes(candidate),
                )
            )
    return sorted(result, key=lambda item: item.target)


def validate_dataset_parameters(target: str, raw: Any) -> dict[str, Any]:
    """Coerce and validate constructor parameters from the registered schema.

    Dataset constructors are the single owner of loader settings.  The worker
    and API use this same registry path, so unknown fields cannot silently
    disappear and browser strings are converted before construction.
    """

    if not isinstance(raw, dict):
        raise ValueError("dataset parameters must be an object")
    dataset_class = _dataset_class(target)
    try:
        signature = inspect.signature(dataset_class.__init__)
        hints = get_type_hints(dataset_class.__init__)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"cannot inspect registered dataset {target}") from exc
    allowed = {
        name: parameter
        for name, parameter in signature.parameters.items()
        if name != "self" and parameter.kind not in (
            inspect.Parameter.VAR_POSITIONAL,
            inspect.Parameter.VAR_KEYWORD,
        )
    }
    unknown = sorted(set(raw) - set(allowed))
    if unknown:
        raise ValueError(f"unknown dataset parameter(s): {', '.join(unknown)}")
    result: dict[str, Any] = {}
    for name, value in raw.items():
        if value in (None, ""):
            continue
        result[name] = _coerce_parameter(name, value, hints.get(name), allowed[name])
    return result


def _dataset_class(target: str) -> type[Dataset]:
    allowed = {item.target for item in discover_datasets()}
    if target not in allowed:
        raise ValueError(f"dataset target is not registered: {target}")
    module_name, class_name = target.rsplit(".", 1)
    candidate = getattr(importlib.import_module(module_name), class_name, None)
    if not inspect.isclass(candidate) or not issubclass(candidate, Dataset):
        raise ValueError(f"unknown dataset target: {target}")
    return candidate


def _coerce_parameter(name: str, value: Any, annotation: Any, parameter: inspect.Parameter) -> Any:
    """Apply the primitive type declared by the trusted constructor."""

    options = get_args(annotation)
    if options and (get_origin(annotation) in (UnionType,)):
        annotation = next((item for item in options if item is not type(None)), str)
    if annotation in (None, inspect.Parameter.empty):
        annotation = type(parameter.default) if parameter.default is not inspect.Parameter.empty else str
    try:
        if annotation is bool:
            if isinstance(value, bool):
                return value
            if str(value).lower() in {"true", "1"}:
                return True
            if str(value).lower() in {"false", "0"}:
                return False
            raise ValueError
        if annotation is int:
            return int(value)
        if annotation is float:
            return float(value)
        if annotation is str:
            return str(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid dataset parameter {name}") from exc
    return value


def _num_classes(dataset_class: type[Dataset], config: dict[str, Any] | None = None) -> int | None:
    """Read validated class-count metadata without constructing a dataset."""

    value = dataset_class.num_classes(config or {})
    if value is not None and (not isinstance(value, int) or value < 1):
        target = f"{dataset_class.__module__}.{dataset_class.__name__}"
        raise ValueError(f"{target}.num_classes must return a positive integer or None")
    return value
