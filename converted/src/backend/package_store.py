"""Authenticated, digest-addressed storage for executable package bundles."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from package_runtime.loader import bundle_digest, canonical_bundle, validate_bundle


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

        if bundle.get("schema_version") != 1 or bundle.get("format") != "package-bundle/v1":
            raise ValueError("unsupported package bundle format")
        if not isinstance(bundle.get("graph"), dict) or not isinstance(bundle.get("packages"), list):
            raise ValueError("package bundle requires graph and packages")
        for package in bundle["packages"]:
            if not isinstance(package, dict):
                raise ValueError("package bundle entries must be objects")
            validate_bundle(package)
        digest = bundle_digest(bundle)
        if declared_digest is not None and declared_digest.lower() != digest:
            raise ValueError("package bundle digest mismatch")
        record = {
            "bundle_ref": digest,
            "sha256": digest,
            "owner_connection_id": owner_connection_id,
            "bundle": bundle,
        }
        destination = self._bundle_path(digest)
        destination.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix="bundle-", suffix=".json", dir=destination.parent)
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
        return {
            "bundle_ref": digest,
            "digest": digest,
            "size": len(canonical_bundle(bundle)),
        }

    def get_bundle(self, bundle_ref: str, *, owner_connection_id: str) -> dict[str, Any]:
        """Return an owned, digest-verified browser bundle."""

        if not _is_digest(bundle_ref):
            raise KeyError(bundle_ref)
        record = json.loads(self._bundle_path(bundle_ref).read_text(encoding="utf-8"))
        if record.get("owner_connection_id") != owner_connection_id:
            raise KeyError(bundle_ref)
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


def _is_digest(value: str) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(
        character in "0123456789abcdef" for character in value.lower()
    )
