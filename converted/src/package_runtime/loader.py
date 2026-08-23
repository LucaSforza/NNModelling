"""Package validation and restricted PyTorch entrypoint loading."""

from __future__ import annotations

import ast
import base64
import hashlib
import json
import types
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import torch


class PackageValidationError(ValueError):
    """Raised when a package bundle cannot be safely compiled."""


@dataclass(frozen=True)
class PackageFile:
    """One immutable source file in a package."""

    path: str
    content: bytes
    sha256: str


@dataclass(frozen=True)
class ValidatedPackage:
    """Validated package manifest and source files."""

    package_id: str
    version: str
    dependencies: dict[str, str]
    files: dict[str, PackageFile]
    manifest: dict[str, Any]


def canonical_bundle(bundle: Mapping[str, Any]) -> bytes:
    """Return the stable bytes used for upload and persistence digests."""

    payload = {key: value for key, value in bundle.items() if key != "digest"}
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def bundle_digest(bundle: Mapping[str, Any]) -> str:
    """Compute the SHA-256 digest of a canonical bundle."""

    return hashlib.sha256(canonical_bundle(bundle)).hexdigest()


def validate_bundle(bundle: Mapping[str, Any]) -> ValidatedPackage:
    """Validate manifest, file digests and dependency metadata."""

    manifest = bundle.get("manifest")
    raw_files = bundle.get("files")
    if not isinstance(manifest, Mapping) or not isinstance(raw_files, Mapping):
        raise PackageValidationError("package requires manifest and files")
    package_id = manifest.get("id")
    version = manifest.get("version")
    if manifest.get("schemaVersion") != 1:
        raise PackageValidationError("unsupported package schemaVersion")
    dependencies = manifest.get("dependencies", {})
    entrypoints = manifest.get("entrypoints")
    if not isinstance(package_id, str) or not package_id or not isinstance(version, str) or not version:
        raise PackageValidationError("manifest id and version are required")
    if not isinstance(dependencies, Mapping) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in dependencies.items()
    ):
        raise PackageValidationError("manifest.dependencies must be a string mapping")
    pytorch = entrypoints.get("pytorch") if isinstance(entrypoints, Mapping) else None
    pytorch_entrypoint = pytorch.get("file") if isinstance(pytorch, Mapping) else pytorch
    if package_id != "core.input" and (not isinstance(pytorch_entrypoint, str) or pytorch_entrypoint not in raw_files):
        raise PackageValidationError("manifest.entrypoints.pytorch must reference a package file")

    files: dict[str, PackageFile] = {}
    for path, raw_file in raw_files.items():
        if not isinstance(path, str) or not _safe_relative_path(path) or not _allowed_resource_path(path):
            raise PackageValidationError(f"invalid package source path: {path!r}")
        if not isinstance(raw_file, Mapping) or not isinstance(raw_file.get("content"), str):
            raise PackageValidationError(f"file {path!r} must contain base64 content")
        try:
            content = base64.b64decode(raw_file["content"], validate=True)
        except (ValueError, TypeError) as exc:
            raise PackageValidationError(f"file {path!r} is not valid base64") from exc
        digest = hashlib.sha256(content).hexdigest()
        if raw_file.get("sha256") != digest:
            raise PackageValidationError(f"file {path!r} digest mismatch")
        files[path] = PackageFile(path, content, digest)

    return ValidatedPackage(package_id, version, dict(dependencies), files, dict(manifest))


def load_builder(package: ValidatedPackage) -> Any:
    """Load a package builder without honoring arbitrary import paths."""

    raw_entrypoint = package.manifest["entrypoints"]["pytorch"]
    entrypoint = raw_entrypoint["file"] if isinstance(raw_entrypoint, Mapping) else raw_entrypoint
    source = package.files[entrypoint].content
    tree = ast.parse(source, filename=entrypoint, mode="exec")
    _validate_source(tree, entrypoint)
    module = types.ModuleType(f"_nnm_package_{package.package_id.replace('.', '_')}")
    module.__file__ = entrypoint
    module.__package__ = ""
    globals_dict = module.__dict__
    globals_dict["__builtins__"] = _safe_builtins()
    globals_dict["__name__"] = module.__name__
    try:
        exec(compile(tree, entrypoint, "exec"), globals_dict, globals_dict)
    except Exception as exc:
        raise PackageValidationError(f"package {package.package_id} failed to load") from exc
    build = globals_dict.get("build")
    if not callable(build):
        raise PackageValidationError(f"package {package.package_id} must define build()")
    return build


def _safe_relative_path(path: str) -> bool:
    from pathlib import PurePosixPath

    parsed = PurePosixPath(path)
    return not parsed.is_absolute() and ".." not in parsed.parts and path == parsed.as_posix()


def _allowed_resource_path(path: str) -> bool:
    """Allow declarative browser resources plus executable Python sources."""

    return path.endswith(".py") or path in {"manifest.json", "stereotype.json", "inference.lua"}


def _validate_source(tree: ast.Module, filename: str) -> None:
    allowed_imports = {"torch", "typing", "copy", "stereotype_runtime"}
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            root = (node.names[0].name if isinstance(node, ast.Import) else node.module or "").split(".")[0]
            if root not in allowed_imports:
                raise PackageValidationError(f"import {root!r} is not allowed in {filename}")
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            raise PackageValidationError(f"global declarations are not allowed in {filename}")


def _safe_builtins() -> dict[str, Any]:
    names = (
        "bool", "dict", "enumerate", "Exception", "float", "int", "isinstance", "len", "list",
        "max", "min", "range", "str", "tuple", "zip", "ValueError", "TypeError", "RuntimeError",
        "__build_class__", "object", "super", "set", "getattr", "setattr", "hasattr",
    )
    import builtins

    return {name: getattr(builtins, name) for name in names} | {"__import__": _restricted_import}


def _restricted_import(name: str, globals: Any = None, locals: Any = None, fromlist: tuple[str, ...] = (), level: int = 0) -> Any:
    if level or name.split(".")[0] not in {"torch", "typing", "copy", "stereotype_runtime"}:
        raise ImportError(f"package import is not allowed: {name}")
    return __import__(name, globals, locals, fromlist, level)
