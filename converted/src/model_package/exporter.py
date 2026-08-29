"""Create deterministic, self-contained pip wheels from training artifacts."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import shutil
import tempfile
import zipfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from package_runtime.compiler import adapter_descriptors

PACKAGE_NAME = re.compile(r"nnm_[A-Za-z][A-Za-z0-9_]*\Z")
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+)*(?:[A-Za-z0-9.+-]*)\Z")
RUNTIME_FILES = ("runtime.py", "adapters.py")
ARCHITECTURE_FINGERPRINT = "nnm_architecture_fingerprint"


def build_model_wheel(
    artifact_dir: str | Path,
    *,
    package_name: str,
    version: str = "0.1.0",
    package: Mapping[str, Any] | None = None,
    input_adapter: Mapping[str, Any] | None = None,
) -> Path:
    """Build a pure-Python inference wheel from a package training artifact."""

    if not PACKAGE_NAME.fullmatch(package_name):
        raise ValueError("package_name must match nnm_<name> using letters, digits, and underscores")
    if not VERSION.fullmatch(version):
        raise ValueError("version is not a valid package version")
    if not isinstance(package, Mapping) or not isinstance(package.get("graph"), Mapping):
        raise ValueError("package must contain a graph mapping")
    artifact_path = Path(artifact_dir).resolve()
    weights_path = artifact_path / "weights.safetensors"
    if not weights_path.is_file():
        raise FileNotFoundError(f"model weights not found: {weights_path}")
    _validate_safe_weights(weights_path)
    module_name = package_name
    architecture = {
        "schema_version": 3,
        "format": "package-model/v1",
        "package": _json_safe(package),
        "prediction": {"program": "prediction"},
        "input_adapter": dict(input_adapter or {"kind": "tensor", "version": 1}),
        "adapters": adapter_descriptors(package),
    }
    architecture["architecture_fingerprint"] = _architecture_fingerprint(architecture)
    dist_dir = artifact_path / "dist"
    dist_dir.mkdir(parents=True, exist_ok=True)
    # Wheel filenames use the normalized import-safe project spelling; pip/uv
    # expose the equivalent distribution name with hyphens.
    wheel_name = f"{module_name}-{version}-py3-none-any.whl"
    wheel_path = dist_dir / wheel_name
    with tempfile.TemporaryDirectory(prefix="nnm-wheel-") as temporary:
        staging = Path(temporary)
        package_dir = staging / module_name
        package_dir.mkdir()
        (package_dir / "__init__.py").write_text(
            "from .runtime import InferenceModel, Model, load_model\n\n"
            "__all__ = ['Model', 'load_model', 'InferenceModel']\n",
            encoding="utf-8",
        )
        (package_dir / "architecture.json").write_text(json.dumps(architecture, sort_keys=True), encoding="utf-8")
        _vendor_weights(weights_path, package_dir / "weights.safetensors", architecture["architecture_fingerprint"])
        _copy_runtime(package_dir)
        dist_info = staging / f"{module_name}-{version}.dist-info"
        dist_info.mkdir()
        (dist_info / "METADATA").write_text(_metadata(package_name, version), encoding="utf-8")
        (dist_info / "WHEEL").write_text(
            "Wheel-Version: 1.0\nGenerator: NNModelling\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
            encoding="utf-8",
        )
        _write_wheel(staging, wheel_path)
    manifest = {
        "schema_version": 1,
        "package_name": package_name,
        "version": version,
        "wheel": str(Path("dist") / wheel_name),
        "sha256": _sha256(wheel_path),
        "input_adapter": architecture["input_adapter"],
        "adapters": architecture["adapters"],
        "architecture_fingerprint": architecture["architecture_fingerprint"],
    }
    (artifact_path / "model-package.json").write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return wheel_path


def _validate_safe_weights(weights_path: Path) -> None:
    """Reject weights that are not a loadable safetensors container.

    Opening the container parses and validates its header, so a truncated or
    garbage file raises here; an empty container is rejected explicitly
    because an inference wheel without tensors is not a model.
    """
    from safetensors import safe_open

    with safe_open(str(weights_path), framework="pt") as handle:
        if not handle.keys():
            raise ValueError("weights.safetensors contains no tensors")


def _vendor_weights(source: Path, destination: Path, fingerprint: str) -> None:
    """Write a validated, metadata-bearing copy of the training state."""

    from safetensors.torch import save_file
    from safetensors import safe_open

    with safe_open(str(source), framework="pt") as handle:
        tensors = {name: handle.get_tensor(name) for name in handle.keys()}
    wrapper_prefix = "module."
    has_wrapper_keys = [name.startswith(wrapper_prefix) for name in tensors]
    if any(has_wrapper_keys) and not all(has_wrapper_keys):
        raise ValueError("weights.safetensors contains mixed wrapper and graph state-dict keys")
    if tensors and not has_wrapper_keys[0]:
        tensors = {f"{wrapper_prefix}{name}": tensor for name, tensor in tensors.items()}
    save_file(tensors, str(destination), metadata={ARCHITECTURE_FINGERPRINT: fingerprint})


def _architecture_fingerprint(architecture: Mapping[str, Any]) -> str:
    """Hash architecture metadata without recursively hashing its own digest."""

    payload = {key: value for key, value in architecture.items() if key != "architecture_fingerprint"}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _copy_runtime(package_dir: Path) -> None:
    source_dir = Path(__file__).resolve().parent
    for filename in RUNTIME_FILES:
        shutil.copy2(source_dir / filename, package_dir / filename)
    runtime_dir = package_dir / "package_runtime"
    runtime_dir.mkdir()
    shutil.copy2(source_dir.parent / "package_runtime" / "__init__.py", runtime_dir / "__init__.py")
    compiler = (source_dir.parent / "package_runtime" / "compiler.py").read_text(encoding="utf-8")
    compiler = compiler.replace(
        "from stereotype_runtime import pytorch as stereotype_pytorch\nfrom stereotype_runtime.pytorch import BuildContext, StereotypeReference",
        "from ..stereotype_runtime import pytorch as stereotype_pytorch\nfrom ..stereotype_runtime.pytorch import BuildContext, StereotypeReference",
    )
    (runtime_dir / "compiler.py").write_text(compiler, encoding="utf-8")
    shutil.copy2(source_dir.parent / "package_runtime" / "loader.py", runtime_dir / "loader.py")
    stereotype_dir = package_dir / "stereotype_runtime"
    stereotype_dir.mkdir()
    source_stereotype = source_dir.parent / "stereotype_runtime"
    shutil.copy2(source_stereotype / "__init__.py", stereotype_dir / "__init__.py")
    shutil.copy2(source_stereotype / "pytorch.py", stereotype_dir / "pytorch.py")


def _metadata(package_name: str, version: str) -> str:
    return (
        "Metadata-Version: 2.1\n"
        f"Name: {package_name}\n"
        f"Version: {version}\n"
        "Summary: Exported NNModelling inference model\n"
        "Requires-Python: >=3.12\n"
        "Requires-Dist: torch\n"
        "Requires-Dist: safetensors\n"
    )


def _write_wheel(staging: Path, destination: Path) -> None:
    files = sorted(path for path in staging.rglob("*") if path.is_file())
    record_path = next(path for path in staging.rglob("*.dist-info") if path.is_dir()) / "RECORD"
    records = [f"{path.relative_to(staging).as_posix()},{_record_hash(path)},{path.stat().st_size}" for path in files]
    records.append(f"{record_path.relative_to(staging).as_posix()},,")
    record_path.write_text("\n".join(records) + "\n", encoding="utf-8")
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(path for path in staging.rglob("*") if path.is_file()):
            archive.write(path, path.relative_to(staging).as_posix())


def _record_hash(path: Path) -> str:
    digest = hashlib.sha256(path.read_bytes()).digest()
    return "sha256=" + base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _json_safe(value: Any) -> Any:
    """Copy a bundle while rejecting values that cannot be wheel metadata."""

    try:
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise ValueError("package bundle must contain JSON-compatible values") from exc
    return json.loads(encoded)
