"""Discover dataset classes installed in the backend or a project workspace.

Two discovery paths exist:

- :func:`discover_datasets` without arguments scans the trusted installed
  ``dataset`` package exactly as before (legacy behavior preserved).
- :func:`discover_project_datasets` scans a project's ``datasets/`` directory
  and imports only modules below it, requiring subclasses of the canonical
  ``dataset.ds.Dataset`` base. Project imports run in isolation: the project
  ``datasets/`` directory is added to ``sys.path`` only for the duration of
  the scan and every module newly registered in ``sys.modules`` is removed
  afterwards, so discovery never leaks global import state.
"""

from __future__ import annotations

import importlib
import importlib.util
import inspect
import json
import pkgutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, get_type_hints

from dataset.ds import Dataset

from backend.models import DatasetInfo, DatasetParameter

PROJECT_DATASETS_SUBDIR = "datasets"


@dataclass
class DatasetDiscovery:
    """Datasets plus per-module import/validation errors from one scan."""

    datasets: list[DatasetInfo]
    errors: list[dict[str, str]]


def discover_datasets(project_root: str | Path | None = None) -> list[DatasetInfo]:
    """Find concrete ``Dataset`` subclasses in the installed package.

    Args:
        project_root: When given, project datasets from ``<root>/datasets``
            are discovered alongside the installed package.

    Returns:
        Sorted ``DatasetInfo`` list; import failures for project modules are
        reported through :func:`discover_project_datasets` and never raise.
    """

    if project_root is not None:
        return discover_project_datasets(project_root).datasets
    return _discover_package_datasets()


def discover_project_datasets(project_root: str | Path) -> DatasetDiscovery:
    """Find validated project dataset subclasses below ``<root>/datasets``.

    Only files under the project's ``datasets/`` directory are imported, with
    the directory on ``sys.path`` for the duration of the scan. Every module
    added to ``sys.modules`` by the scan is removed afterwards so a project's
    module names cannot shadow later scans or the companion's own imports.

    Returns:
        Validated ``DatasetInfo`` entries and per-module errors; a module that
        raises while importing, defines no valid subclass, or carries invalid
        class-count metadata is reported without failing the whole scan.
    """

    datasets_dir = Path(project_root) / PROJECT_DATASETS_SUBDIR
    datasets: list[DatasetInfo] = []
    errors: list[dict[str, str]] = []
    if not datasets_dir.is_dir():
        return DatasetDiscovery(datasets, errors)

    python_files: list[Path] = []
    for path in sorted(datasets_dir.rglob("*.py")):
        if "__pycache__" in path.parts or path.name.startswith("."):
            continue
        rel_posix = path.relative_to(datasets_dir).as_posix()
        if not _resolves_inside_root(path, datasets_dir):
            errors.append(
                {
                    "path": rel_posix,
                    "error": f"{rel_posix} resolves outside the project datasets "
                    "directory and was not imported",
                }
            )
            continue
        python_files.append(path)
    if not python_files:
        return DatasetDiscovery(datasets, errors)

    modules_before = set(sys.modules)
    path_added = str(datasets_dir) not in sys.path
    if path_added:
        sys.path.insert(0, str(datasets_dir))
    try:
        for index, path in enumerate(python_files):
            rel = path.relative_to(datasets_dir)
            rel_posix = rel.as_posix()
            module_name = ".".join(rel.with_suffix("").parts)
            synthetic_name = f"_nnm_project_dataset_{index}"
            module = _import_project_module(
                synthetic_name,
                path,
                module_name,
                rel_posix,
                errors,
            )
            if module is None:
                continue
            for class_name, candidate in inspect.getmembers(module, inspect.isclass):
                if candidate is Dataset or not issubclass(candidate, Dataset):
                    continue
                if getattr(candidate, "__module__", None) != synthetic_name:
                    continue
                target = f"{module_name}.{class_name}"
                try:
                    datasets.append(_describe_dataset_class(candidate, target, source="project"))
                except Exception as exc:  # noqa: BLE001 - per-module isolation
                    # The internal synthetic import name is never user-facing.
                    message = str(exc).replace(synthetic_name, module_name)
                    errors.append({"path": rel_posix, "error": f"{target} is invalid: {message}"})
    finally:
        for module_name in set(sys.modules) - modules_before:
            sys.modules.pop(module_name, None)
        if path_added:
            try:
                sys.path.remove(str(datasets_dir))
            except ValueError:
                pass
    datasets.sort(key=lambda item: item.target)
    return DatasetDiscovery(datasets, errors)


def _import_project_module(
    synthetic_name: str,
    path: Path,
    module_name: str,
    rel_posix: str,
    errors: list[dict[str, str]],
) -> Any | None:
    """Import one project dataset file in isolation, reporting failures."""
    spec = importlib.util.spec_from_file_location(synthetic_name, path)
    if spec is None or spec.loader is None:
        errors.append(
            {"path": rel_posix, "error": f"cannot load dataset module {module_name}"}
        )
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[synthetic_name] = module
    try:
        spec.loader.exec_module(module)
        return module
    except Exception as exc:  # noqa: BLE001 - per-module isolation
        errors.append(
            {"path": rel_posix, "error": f"importing dataset module {module_name} failed: {exc}"}
        )
        return None
    finally:
        sys.modules.pop(synthetic_name, None)


def _resolves_inside_root(candidate: Path, root: Path) -> bool:
    """Return whether a candidate's physical target stays inside the root.

    The candidate path is resolved with symlinks fully followed; only a proper
    descendant of the resolved root is considered inside. A symlinked module
    whose target (or whose chain of symlinks) escapes the root — including a
    broken symlink whose target path lies outside — is rejected before it can
    be executed, so project discovery never imports code reachable only
    through a symlink planted outside ``datasets/``.
    """
    resolved_root = root.resolve()
    resolved = candidate.resolve()
    return resolved != resolved_root and resolved_root in resolved.parents


def _discover_package_datasets() -> list[DatasetInfo]:
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
            result.append(_describe_dataset_class(candidate, target, source="builtin"))
    return sorted(result, key=lambda item: item.target)


def _describe_dataset_class(
    dataset_class: type[Dataset],
    target: str,
    *,
    source: Literal["builtin", "project"],
) -> DatasetInfo:
    """Describe one validated dataset class without constructing it."""

    try:
        signature = inspect.signature(dataset_class.__init__)
        hints = get_type_hints(dataset_class.__init__)
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
    return DatasetInfo(
        target=target,
        name=dataset_class.__name__,
        doc=inspect.getdoc(dataset_class) or "",
        parameters=parameters,
        num_classes=_num_classes(dataset_class),
        source=source,
    )


def _type_name(annotation: Any) -> str:
    """Return a stable display name for a constructor annotation."""

    if annotation is inspect.Parameter.empty:
        return "string"
    if annotation in (str, int, float, bool):
        return annotation.__name__
    return str(annotation).replace("typing.", "")


def _num_classes(dataset_class: type[Dataset], config: dict[str, Any] | None = None) -> int | None:
    """Read validated class-count metadata without constructing a dataset."""

    value = dataset_class.num_classes(config or {})
    if value is not None and (not isinstance(value, int) or value < 1):
        target = f"{dataset_class.__module__}.{dataset_class.__name__}"
        raise ValueError(f"{target}.num_classes must return a positive integer or None")
    return value
