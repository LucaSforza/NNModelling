"""Normalize job training data and generate Hydra configuration files."""

from __future__ import annotations

import json
import importlib
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from hydra import compose, initialize_config_dir
from omegaconf import DictConfig, OmegaConf

from convert import build_hydra_configs


def normalize_training_config(training: dict[str, Any]) -> dict[str, Any]:
    """Normalize the JSON training document to Hydra-compatible mappings.

    The dataset may be supplied as a shorthand import path or as a complete
    Hydra mapping. All other sections are copied without dropping unknown
    Hydra fields.
    """

    normalized = json.loads(json.dumps(training))
    dataset = normalized.get("dataset")
    if isinstance(dataset, str):
        normalized["dataset"] = {"_target_": dataset}
    elif not isinstance(dataset, dict) or not dataset.get("_target_"):
        raise ValueError("training.dataset must be a Python target string or Hydra mapping")
    return normalized


def _section(training: dict[str, Any], name: str, default: dict[str, Any]) -> dict[str, Any]:
    """Return a copied Hydra section, preserving arbitrary fields."""

    value = training.get(name, default)
    if not isinstance(value, dict):
        raise ValueError(f"training.{name} must be a JSON object")
    return json.loads(json.dumps(value))


def _resolve_config(config_dir: Path, overrides: list[str]) -> DictConfig:
    """Compose a generated Hydra config with user-provided overrides."""

    with initialize_config_dir(config_dir=str(config_dir.resolve()), version_base=None):
        return compose(config_name="base", overrides=overrides)


def _dataset_num_classes(dataset_config: dict[str, Any]) -> int | None:
    """Read a dataset's static classification cardinality without loading data."""

    target = dataset_config.get("_target_")
    if not isinstance(target, str) or "." not in target:
        raise ValueError("training.dataset._target_ must be an import path")
    module_name, _, class_name = target.rpartition(".")
    dataset_class = getattr(importlib.import_module(module_name), class_name)
    value = dataset_class.num_classes(dict(dataset_config))
    if value is not None and (not isinstance(value, int) or value < 1):
        raise ValueError(f"{target}.num_classes must return a positive integer or None")
    return value


def _dataset_class_names(dataset_config: dict[str, Any], num_classes: int | None) -> list[str] | None:
    """Read and validate optional class names without loading dataset samples."""

    if num_classes is None:
        return None
    target = dataset_config["_target_"]
    module_name, _, class_name = target.rpartition(".")
    dataset_class = getattr(importlib.import_module(module_name), class_name)
    value = dataset_class.class_names(dict(dataset_config))
    if value is None:
        return [f"class_{index}" for index in range(num_classes)]
    if not isinstance(value, list) or len(value) != num_classes or not all(isinstance(name, str) for name in value):
        raise ValueError(f"{target}.class_names must return {num_classes} strings or None")
    return value


@contextmanager
def _temporary_import_roots(*roots: str | Path):
    """Expose project import roots without leaking global import state.

    A no-op when no roots are given so legacy conversion keeps its exact
    module-cache behavior. When roots are given, each root is added to
    ``sys.path`` for the duration of the block and every project module newly
    registered in ``sys.modules`` (a module whose file lives below one of the
    roots) is removed afterwards. Third-party modules imported as dependencies
    keep their normal cache entry, mirroring the isolation that project
    dataset discovery already provides.
    """
    if not roots:
        yield
        return
    added: list[str] = []
    for root in roots:
        value = str(root)
        if value not in sys.path:
            sys.path.insert(0, value)
            added.append(value)
    resolved_roots = [Path(root).resolve() for root in roots]
    modules_before = set(sys.modules)
    try:
        yield
    finally:
        for module_name in set(sys.modules) - modules_before:
            module = sys.modules.get(module_name)
            if _module_file_under_roots(module, resolved_roots):
                sys.modules.pop(module_name, None)
        for value in added:
            try:
                sys.path.remove(value)
            except ValueError:
                pass


def _module_file_under_roots(module: Any, roots: list[Path]) -> bool:
    """Return whether a module's file lives below one of the import roots."""
    module_file = getattr(module, "__file__", None)
    if not module_file:
        return False
    try:
        module_path = Path(module_file).resolve()
    except OSError:
        return False
    return any(module_path == root or root in module_path.parents for root in roots)


def build_job_hydra_configs(
    job: dict[str, Any],
    output_dir: str | Path,
    *,
    import_roots: tuple[str | Path, ...] = (),
) -> Path:
    """Generate Hydra files for a complete remote-training job.

    ``import_roots`` optionally exposes project-local import roots (such as a
    project's ``datasets/`` directory) for the duration of dataset metadata
    resolution without leaking global interpreter state. The generated
    directory is returned. The original job is written by the job manager so
    that conversion remains a pure filesystem operation.
    """

    with _temporary_import_roots(*import_roots):
        output_path = Path(output_dir).resolve()
        output_path.mkdir(parents=True, exist_ok=True)
        network = job.get("network", {})
        if network.get("format") != "nntree":
            raise ValueError("network.format must be 'nntree'")
        nntree = network.get("value")
        if not isinstance(nntree, dict):
            raise ValueError("network.value must be an NNTree object")

        training = normalize_training_config(job.get("training", {}))
        num_classes = training.get("num_classes")
        if num_classes is not None and not isinstance(num_classes, int):
            raise ValueError("training.num_classes must be an integer")
        dataset_config = _section(training, "dataset", {})
        dataset_num_classes = _dataset_num_classes(dataset_config)
        if num_classes is None:
            num_classes = dataset_num_classes
        elif dataset_num_classes is not None and num_classes != dataset_num_classes:
            raise ValueError(
                f"training.num_classes={num_classes} conflicts with the {dataset_num_classes} classes declared by "
                f"{dataset_config['_target_']}"
            )
        class_names = _dataset_class_names(dataset_config, num_classes)

        # The existing converter owns the network-specific transformation. The
        # optional training_config argument lets it write all Hydra groups from
        # this job rather than from narrow CLI flags.
        build_hydra_configs(
            nntree,
            output_dir=str(output_path / "cfg"),
            num_classes=num_classes,
            class_names=class_names,
            training_config={
                "dataset": dataset_config,
                "optimizer": _section(
                    training,
                    "optimizer",
                    {"_target_": "torch.optim.Adam", "lr": 0.001},
                ),
                "trainer": _section(
                    training,
                    "trainer",
                    {"max_epochs": 20, "accelerator": "auto"},
                ),
                "wandb": _section(
                    training,
                    "wandb",
                    {"project": "NeuralNetworks", "name": "Dynamic_Model"},
                ),
                "early_stopping": _section(
                    training,
                    "early_stopping",
                    {"patience": 3, "min_delta": 0.0},
                ),
            },
        )

        overrides = training.get("overrides", [])
        if overrides is None:
            overrides = []
        if not isinstance(overrides, list) or not all(isinstance(item, str) for item in overrides):
            raise ValueError("training.overrides must be a list of Hydra override strings")

        resolved = _resolve_config(output_path / "cfg", overrides)
        resolved_path = output_path / "resolved_config.yaml"
        OmegaConf.save(config=resolved, f=str(resolved_path))
        return output_path / "cfg"
