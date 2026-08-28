"""Authenticated, digest-addressed storage for executable package bundles."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from package_runtime.loader import bundle_digest, canonical_bundle, validate_bundle


MAX_BUNDLE_BYTES = 8 * 1024 * 1024
MAX_PACKAGE_COUNT = 256
MAX_FILE_COUNT = 512
MAX_FILE_BYTES = 1 * 1024 * 1024
MAX_GRAPH_NODES = 4096
MAX_GRAPH_EDGES = 8192
MAX_JSON_DEPTH = 64


class BundleNotFoundError(KeyError):
    """The requested digest is not present or is not owned by the caller."""


class BundleValidationError(ValueError):
    """The uploaded bundle violates the storage contract."""


class PackageStore:
    """Persist validated package bundles below one backend-owned directory."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, bundle: dict[str, Any], *, owner_connection_id: str, declared_digest: str | None = None) -> dict[str, Any]:
        """Validate and atomically persist one bundle for its owner."""

        package = validate_bundle(bundle)
        digest = bundle_digest(bundle)
        if declared_digest is not None and declared_digest.lower() != digest:
            raise ValueError("package digest mismatch")
        record = {
            "id": package.package_id,
            "version": package.version,
            "sha256": digest,
            "owner_connection_id": owner_connection_id,
            "bundle": bundle,
        }
        destination = self._path(package.package_id, package.version)
        destination.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix="package-", suffix=".json", dir=destination.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(record, handle, sort_keys=True, separators=(",", ":"))
            os.replace(temporary_name, destination)
        except Exception:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise
        return {key: record[key] for key in ("id", "version", "sha256")}

    def put_bundle(
        self,
        bundle: dict[str, Any],
        *,
        owner_connection_id: str,
        declared_digest: str | None = None,
    ) -> dict[str, Any]:
        """Persist one complete browser-exported graph bundle by digest."""

        if not isinstance(bundle, dict):
            raise BundleValidationError("package bundle must be a JSON object")
        if bundle.get("schema_version") != 1 or bundle.get("format") != "package-bundle/v1":
            raise BundleValidationError("unsupported package bundle format")
        if not isinstance(bundle.get("graph"), dict) or not isinstance(bundle.get("packages"), list):
            raise BundleValidationError("package bundle requires graph and packages")
        nodes = bundle["graph"].get("nodes", [])
        edges = bundle["graph"].get("edges", [])
        if not isinstance(nodes, list) or not isinstance(edges, list):
            raise BundleValidationError("package graph nodes and edges must be arrays")
        if len(nodes) > MAX_GRAPH_NODES or len(edges) > MAX_GRAPH_EDGES:
            raise BundleValidationError("package graph exceeds size limits")
        if len(bundle["packages"]) > MAX_PACKAGE_COUNT:
            raise BundleValidationError("package bundle contains too many packages")
        encoded_size = len(canonical_bundle(bundle))
        if encoded_size > MAX_BUNDLE_BYTES:
            raise BundleValidationError("package bundle exceeds the maximum size")
        if _json_depth(bundle) > MAX_JSON_DEPTH:
            raise BundleValidationError("package bundle is too deeply nested")
        for package in bundle["packages"]:
            if not isinstance(package, dict):
                raise BundleValidationError("package bundle entries must be objects")
            try:
                validated = validate_bundle(package)
            except ValueError as exc:
                raise BundleValidationError(str(exc)) from exc
            if len(validated.files) > MAX_FILE_COUNT:
                raise BundleValidationError("package contains too many files")
            if any(len(file.content) > MAX_FILE_BYTES for file in validated.files.values()):
                raise BundleValidationError("package file exceeds the maximum size")
        digest = bundle_digest(bundle)
        if declared_digest is not None and declared_digest.lower() != digest:
            raise ValueError("package bundle digest mismatch")
        record = {
            "bundle_ref": digest,
            "sha256": digest,
            "bundle": bundle,
        }
        destination = self._bundle_path(digest)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            fd, temporary_name = tempfile.mkstemp(prefix="bundle-", suffix=".json", dir=destination.parent)
            try:
                with os.fdopen(fd, "x", encoding="utf-8") as handle:
                    json.dump(record, handle, sort_keys=True, separators=(",", ":"))
                # Hard-linking is atomic and fails if another uploader won
                # the digest first; unlike replace(), it can never overwrite
                # an immutable content-addressed record.
                os.link(temporary_name, destination)
                os.unlink(temporary_name)
            except FileExistsError:
                os.unlink(temporary_name)
            except Exception:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                raise
        else:
            existing = json.loads(destination.read_text(encoding="utf-8"))
            if existing.get("sha256") != digest or existing.get("bundle") != bundle:
                raise BundleValidationError("digest collision in package storage")
        self._grant_owner(digest, owner_connection_id)
        return {
            "bundle_ref": digest,
            "digest": digest,
            "size": len(canonical_bundle(bundle)),
        }

    def get_bundle(self, bundle_ref: str, *, owner_connection_id: str) -> dict[str, Any]:
        """Return an owned, digest-verified browser bundle."""

        if not _is_digest(bundle_ref):
            raise KeyError(bundle_ref)
        try:
            record = json.loads(self._bundle_path(bundle_ref).read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            raise BundleNotFoundError(bundle_ref) from exc
        if not self._owner_path(bundle_ref, owner_connection_id).exists():
            raise BundleNotFoundError(bundle_ref)
        bundle = record.get("bundle")
        if not isinstance(bundle, dict) or bundle_digest(bundle) != record.get("sha256"):
            raise ValueError("stored package bundle digest cannot be verified")
        return record

    def get(self, package_id: str, version: str, *, owner_connection_id: str) -> dict[str, Any]:
        """Return an owned bundle record, rejecting path traversal."""

        record = json.loads(self._path(package_id, version).read_text(encoding="utf-8"))
        if record.get("owner_connection_id") != owner_connection_id:
            raise KeyError(package_id)
        bundle = record.get("bundle")
        if not isinstance(bundle, dict) or bundle_digest(bundle) != record.get("sha256"):
            raise ValueError("stored package digest cannot be verified")
        return record

    def delete(self, package_id: str, version: str, *, owner_connection_id: str) -> None:
        """Delete an owned bundle."""

        path = self._path(package_id, version)
        record = json.loads(path.read_text(encoding="utf-8"))
        if record.get("owner_connection_id") != owner_connection_id:
            raise KeyError(package_id)
        path.unlink()

    def _path(self, package_id: str, version: str) -> Path:
        """Map validated identifiers to a private path without client paths."""

        combined = package_id + version
        if not package_id or not version or "/" in combined or "\\" in combined or ".." in combined:
            raise KeyError(package_id)
        return (self.root / package_id / f"{version}.json").resolve()

    def _bundle_path(self, digest: str) -> Path:
        if not _is_digest(digest):
            raise KeyError(digest)
        return (self.root / "bundles" / f"{digest}.json").resolve()

    def _owner_path(self, digest: str, owner_connection_id: str) -> Path:
        if not owner_connection_id or "/" in owner_connection_id or "\\" in owner_connection_id:
            raise BundleNotFoundError(digest)
        return (self.root / "owners" / owner_connection_id / f"{digest}.acl").resolve()

    def _grant_owner(self, digest: str, owner_connection_id: str) -> None:
        path = self._owner_path(digest, owner_connection_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)


def _is_digest(value: str) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(
        character in "0123456789abcdef" for character in value.lower()
    )


def _json_depth(value: Any, depth: int = 0) -> int:
    if isinstance(value, dict):
        return max(((_json_depth(item, depth + 1)) for item in value.values()), default=depth)
    if isinstance(value, list):
        return max(((_json_depth(item, depth + 1)) for item in value), default=depth)
    return depth
