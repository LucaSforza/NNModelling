"""Bounded, immutable storage for authenticated project dataset archives.

The API process treats the archive as data.  It validates the declarative
closure and ZIP metadata, but never imports or executes ``dataset.py``.  The
archive is kept intact for the worker, which receives a server-resolved path
through the trusted container boundary.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any
from collections.abc import Mapping

from dataset.contracts import DatasetDefinition, DatasetReference, DatasetSourceManifest


MAX_DATASET_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_DATASET_FILE_BYTES = 16 * 1024 * 1024
MAX_DATASET_FILES = 2048
MAX_DATASET_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
REQUIRED_DATASET_FILES = frozenset({"manifest.json", "dataset.json", "dataset.py"})


class DatasetArchiveNotFoundError(KeyError):
    """The archive is missing or is not owned by the requesting connection."""


class DatasetArchiveValidationError(ValueError):
    """The archive is not a valid project dataset closure."""


class DatasetArchiveStore:
    """Persist one complete project dataset archive per content digest."""

    def __init__(self, root: str | Path, *, max_archive_bytes: int = MAX_DATASET_ARCHIVE_BYTES) -> None:
        if max_archive_bytes < 1:
            raise ValueError("max_archive_bytes must be positive")
        self.root = Path(root).resolve()
        self.max_archive_bytes = max_archive_bytes
        self.archive_root = self.root / "archives"
        self.owner_root = self.root / "owners"
        self.archive_root.mkdir(parents=True, exist_ok=True)
        self.owner_root.mkdir(parents=True, exist_ok=True)

    def put(
        self,
        archive: bytes,
        *,
        owner_connection_id: str,
        declared_digest: str | None = None,
    ) -> dict[str, Any]:
        """Validate and atomically publish an owned immutable archive.

        Validation happens entirely before the final archive and metadata paths
        are published.  A duplicate digest is put-if-absent and only receives
        another owner ACL entry; existing bytes are never replaced.
        """

        if not isinstance(archive, bytes):
            raise DatasetArchiveValidationError("dataset archive must be bytes")
        if len(archive) > self.max_archive_bytes:
            raise DatasetArchiveValidationError(self._size_error(len(archive)))
        if not _is_owner_id(owner_connection_id):
            raise DatasetArchiveValidationError("owner connection is invalid")
        digest = hashlib.sha256(archive).hexdigest()
        if declared_digest is not None:
            if not _is_digest(declared_digest) or declared_digest.lower() != digest:
                raise DatasetArchiveValidationError("dataset archive digest mismatch")
        metadata = _validate_archive(archive, max_archive_bytes=self.max_archive_bytes)
        record = {
            "digest": digest,
            "size": len(archive),
            "id": metadata["id"],
            "version": metadata["version"],
            "manifest": metadata["manifest"],
            "definition": metadata["definition"],
        }
        archive_path = self._archive_path(digest)
        record_path = self._record_path(digest)
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        if not archive_path.exists():
            self._publish(archive_path, record_path, archive, record)
        existing = self._read_record(digest)
        if existing != record or _sha256_file(archive_path) != digest:
            raise DatasetArchiveValidationError("digest collision in dataset storage")
        self._grant_owner(digest, owner_connection_id)
        reference = DatasetReference(
            kind="project",
            id=metadata["id"],
            version=metadata["version"],
            ref=f"dataset_{digest[:24]}",
            digest=digest,
        )
        return {
            "reference": reference.model_dump(mode="json"),
            "digest": digest,
            "size": len(archive),
            "limit": self.max_archive_bytes,
        }

    def resolve(self, reference: DatasetReference, *, owner_connection_id: str) -> Path:
        """Resolve an owned opaque reference to the immutable archive path.

        This method is for the trusted scheduler/controller boundary.  The
        returned host path must never be serialized into a browser or job API
        response.
        """

        if reference.kind != "project" or reference.digest is None or not _is_digest(reference.digest):
            raise DatasetArchiveNotFoundError(reference.ref)
        digest = reference.digest.lower()
        if reference.ref != f"dataset_{digest[:24]}":
            raise DatasetArchiveNotFoundError(reference.ref)
        if not self._owner_path(digest, owner_connection_id).is_file():
            raise DatasetArchiveNotFoundError(reference.ref)
        record = self._read_record(digest)
        if record["id"] != reference.id or record["version"] != reference.version:
            raise DatasetArchiveNotFoundError(reference.ref)
        archive_path = self._archive_path(digest)
        if not archive_path.is_file() or _sha256_file(archive_path) != digest:
            raise DatasetArchiveValidationError("stored dataset archive digest cannot be verified")
        metadata = _validate_archive(archive_path.read_bytes(), max_archive_bytes=self.max_archive_bytes)
        if (
            record["id"] != metadata["id"]
            or record["version"] != metadata["version"]
            or record.get("manifest") != metadata["manifest"]
            or record.get("definition") != metadata["definition"]
        ):
            raise DatasetArchiveValidationError("stored dataset metadata cannot be verified")
        return archive_path

    def metadata(self, reference: DatasetReference, *, owner_connection_id: str) -> dict[str, Any]:
        """Return owned declarative metadata without exposing storage paths."""

        path = self.resolve(reference, owner_connection_id=owner_connection_id)
        del path
        return self._read_record(reference.digest.lower())  # type: ignore[union-attr]

    def validate_parameters(
        self,
        reference: DatasetReference,
        raw: Mapping[str, Any],
        *,
        owner_connection_id: str,
    ) -> dict[str, Any]:
        """Validate project parameters from stored declarative metadata only."""
        metadata = self.metadata(reference, owner_connection_id=owner_connection_id)
        definition = DatasetDefinition.model_validate(metadata["definition"])
        if not isinstance(raw, Mapping):
            raise DatasetArchiveValidationError("dataset parameters must be an object")
        names = {parameter.name for parameter in definition.parameters}
        unknown = sorted(set(raw) - names)
        if unknown:
            raise DatasetArchiveValidationError(f"unknown dataset parameter(s): {', '.join(unknown)}")
        normalized: dict[str, Any] = {}
        for parameter in definition.parameters:
            if parameter.name not in raw:
                if parameter.required:
                    raise DatasetArchiveValidationError(f"missing required dataset parameter: {parameter.name}")
                if parameter.default is not None:
                    normalized[parameter.name] = parameter.default
                continue
            value = raw[parameter.name]
            valid = (
                parameter.type == "string" and isinstance(value, str)
                or parameter.type == "integer" and isinstance(value, int) and not isinstance(value, bool)
                or parameter.type == "number" and isinstance(value, (int, float)) and not isinstance(value, bool)
                or parameter.type == "boolean" and isinstance(value, bool)
            )
            if not valid:
                raise DatasetArchiveValidationError(f"invalid dataset parameter {parameter.name}")
            normalized[parameter.name] = value
        return normalized

    def extract(self, reference: DatasetReference, *, owner_connection_id: str, destination: str | Path) -> Path:
        """Extract an owned archive into a private worker directory.

        The archive has already passed the complete-path and special-file
        checks in :meth:`resolve`; extraction remains explicit and confined to
        the caller-owned destination so project Python is only visible to the
        worker container.
        """
        archive_path = self.resolve(reference, owner_connection_id=owner_connection_id)
        target = Path(destination).resolve()
        target.mkdir(parents=True, exist_ok=False)
        with zipfile.ZipFile(archive_path) as archive:
            for info in archive.infolist():
                path = (target / PurePosixPath(info.filename)).resolve()
                try:
                    path.relative_to(target)
                except ValueError as exc:  # defensive: resolve() is not a validation boundary
                    raise DatasetArchiveValidationError("dataset archive path escapes its root") from exc
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.read(info.filename))
        return target

    def _publish(self, archive_path: Path, record_path: Path, archive: bytes, record: dict[str, Any]) -> None:
        temporary_archive: Path | None = None
        temporary_record: Path | None = None
        try:
            fd, temporary_name = tempfile.mkstemp(prefix="dataset-", suffix=".zip", dir=archive_path.parent)
            temporary_archive = Path(temporary_name)
            with os.fdopen(fd, "wb") as handle:
                handle.write(archive)
                handle.flush()
                os.fsync(handle.fileno())
            fd, temporary_name = tempfile.mkstemp(prefix="dataset-", suffix=".json", dir=archive_path.parent)
            temporary_record = Path(temporary_name)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(record, handle, sort_keys=True, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            # Both files are put-if-absent.  A concurrent winner is accepted
            # only after the caller rechecks its complete record and digest.
            os.link(temporary_archive, archive_path)
            os.link(temporary_record, record_path)
        except FileExistsError:
            if not archive_path.exists() or not record_path.exists():
                raise DatasetArchiveValidationError("concurrent dataset publication is incomplete")
        finally:
            if temporary_archive is not None:
                temporary_archive.unlink(missing_ok=True)
            if temporary_record is not None:
                temporary_record.unlink(missing_ok=True)

    def _read_record(self, digest: str) -> dict[str, Any]:
        try:
            record = json.loads(self._record_path(digest).read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            raise DatasetArchiveNotFoundError(digest) from exc
        if (
            not isinstance(record, dict)
            or record.get("digest") != digest
            or not isinstance(record.get("id"), str)
            or not isinstance(record.get("version"), str)
        ):
            raise DatasetArchiveValidationError("stored dataset metadata cannot be verified")
        return record

    def _grant_owner(self, digest: str, owner_connection_id: str) -> None:
        path = self._owner_path(digest, owner_connection_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)

    def _archive_path(self, digest: str) -> Path:
        if not _is_digest(digest):
            raise DatasetArchiveNotFoundError(digest)
        return self.archive_root / digest[:2] / f"{digest}.zip"

    def _record_path(self, digest: str) -> Path:
        if not _is_digest(digest):
            raise DatasetArchiveNotFoundError(digest)
        return self.archive_root / digest[:2] / f"{digest}.json"

    def _owner_path(self, digest: str, owner_connection_id: str) -> Path:
        if not _is_digest(digest) or not _is_owner_id(owner_connection_id):
            raise DatasetArchiveNotFoundError(digest)
        return self.owner_root / owner_connection_id / f"{digest}.acl"

    def _size_error(self, size: int) -> str:
        return f"dataset archive exceeds maximum size ({self.max_archive_bytes} bytes; received {size})"


def _validate_archive(archive: bytes, *, max_archive_bytes: int) -> dict[str, Any]:
    """Validate ZIP closure and return only declarative metadata."""

    del max_archive_bytes  # The compressed archive size is checked by ``put``.
    try:
        stream = zipfile.ZipFile(__import__("io").BytesIO(archive))
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        raise DatasetArchiveValidationError("dataset archive is not a valid ZIP") from exc
    with stream:
        infos = stream.infolist()
        if not infos:
            raise DatasetArchiveValidationError("dataset archive is empty")
        if len(infos) > MAX_DATASET_FILES:
            raise DatasetArchiveValidationError("dataset archive contains too many files")
        names: set[str] = set()
        total_size = 0
        for info in infos:
            name = _validate_archive_name(info)
            if name in names:
                raise DatasetArchiveValidationError(f"dataset archive contains duplicate path: {name}")
            names.add(name)
            if info.file_size > MAX_DATASET_FILE_BYTES:
                raise DatasetArchiveValidationError(f"dataset archive file exceeds the maximum size: {name}")
            total_size += info.file_size
            if total_size > MAX_DATASET_UNCOMPRESSED_BYTES:
                raise DatasetArchiveValidationError("dataset archive expands beyond the maximum size")
        if not REQUIRED_DATASET_FILES.issubset(names):
            missing = ", ".join(sorted(REQUIRED_DATASET_FILES - names))
            raise DatasetArchiveValidationError(f"dataset archive is missing: {missing}")
        if any(name not in REQUIRED_DATASET_FILES and not name.startswith("data/") for name in names):
            raise DatasetArchiveValidationError("dataset archive contains a file outside data/")
        try:
            manifest = DatasetSourceManifest.model_validate(json.loads(stream.read("manifest.json")))
            definition = DatasetDefinition.model_validate(json.loads(stream.read("dataset.json")))
        except Exception as exc:  # Pydantic and JSON errors are one public validation category.
            raise DatasetArchiveValidationError(f"dataset declarative metadata is invalid: {exc}") from exc
        if manifest.id != definition.id or manifest.version != definition.version:
            raise DatasetArchiveValidationError("dataset manifest and definition identities do not match")
        return {
            "id": definition.id,
            "version": definition.version,
            "manifest": manifest.model_dump(mode="json"),
            "definition": definition.model_dump(mode="json"),
        }


def _validate_archive_name(info: zipfile.ZipInfo) -> str:
    name = info.filename
    if not name or "\x00" in name or "\\" in name:
        raise DatasetArchiveValidationError("dataset archive contains an invalid path")
    path = PurePosixPath(name)
    if name.startswith("/") or any(part in {"", ".", ".."} for part in path.parts):
        raise DatasetArchiveValidationError(f"dataset archive path escapes its root: {name}")
    if info.is_dir() or name.endswith("/"):
        raise DatasetArchiveValidationError("dataset archive directories are not allowed")
    mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(mode)
    if file_type not in {0, stat.S_IFREG}:
        raise DatasetArchiveValidationError(f"dataset archive contains a special file: {name}")
    if info.flag_bits & 0x1:
        raise DatasetArchiveValidationError("encrypted dataset archives are not supported")
    return "/".join(path.parts)


def _is_digest(value: str) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(character in "0123456789abcdef" for character in value.lower())


def _is_owner_id(value: str) -> bool:
    """Keep the ACL filename below the store even for malformed callers."""

    return bool(value) and value not in {".", ".."} and "\x00" not in value and "/" not in value and "\\" not in value


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()
