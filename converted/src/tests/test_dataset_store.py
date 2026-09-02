"""Security and ownership coverage for project dataset archive storage."""

from __future__ import annotations

import io
import json
import stat
import zipfile
import asyncio
from types import SimpleNamespace
from pathlib import Path

import httpx
import pytest

from backend.app import create_app
from backend.auth import AuthService, InMemoryAuthStore
from backend.dataset_store import (
    DatasetArchiveNotFoundError,
    DatasetArchiveStore,
    DatasetArchiveValidationError,
)
from dataset.contracts import DatasetReference
from backend.package_store import PackageStore


def make_archive(*, extra: dict[str, bytes] | None = None, names: list[str] | None = None) -> bytes:
    files = {
        "manifest.json": json.dumps({
            "schemaVersion": 1,
            "id": "demo.tokens",
            "version": "1.0.0",
            "entrypoints": {"definition": "dataset.json", "python": "dataset.py"},
        }).encode(),
        "dataset.json": json.dumps({
            "schemaVersion": 1,
            "id": "demo.tokens",
            "version": "1.0.0",
            "name": "Tokens",
            "parameters": [],
            "batch": {"inputs": {"tokens": {"shape": ["B"], "dtype": "int64"}}, "targets": {}},
        }).encode(),
        "dataset.py": b"raise RuntimeError('must only run in worker')\n",
        "data/train.pt": b"data",
    }
    if extra:
        files.update(extra)
    if names is not None:
        files = {name: files.get(name, b"x") for name in names}
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return stream.getvalue()


def test_archive_round_trip_deduplicates_and_scopes_owners(tmp_path: Path) -> None:
    store = DatasetArchiveStore(tmp_path)
    archive = make_archive()
    first = store.put(archive, owner_connection_id="alice")
    second = store.put(archive, owner_connection_id="bob", declared_digest=first["digest"])
    assert first == second
    reference = DatasetReference.model_validate(first["reference"])
    assert store.resolve(reference, owner_connection_id="alice").is_file()
    assert store.resolve(reference, owner_connection_id="bob").is_file()
    with pytest.raises(DatasetArchiveNotFoundError):
        store.resolve(reference, owner_connection_id="mallory")


def test_archive_rejects_invalid_digest_and_size_before_publication(tmp_path: Path) -> None:
    archive = make_archive()
    store = DatasetArchiveStore(tmp_path, max_archive_bytes=len(archive) - 1)
    with pytest.raises(DatasetArchiveValidationError, match="maximum size"):
        store.put(archive, owner_connection_id="owner")
    assert not list(tmp_path.rglob("*.zip"))

    store = DatasetArchiveStore(tmp_path / "digest")
    with pytest.raises(DatasetArchiveValidationError, match="digest mismatch"):
        store.put(archive, owner_connection_id="owner", declared_digest="0" * 64)
    assert not list((tmp_path / "digest").rglob("*.zip"))

    with pytest.raises(DatasetArchiveValidationError, match="owner"):
        DatasetArchiveStore(tmp_path / "owner").put(archive, owner_connection_id="..")


@pytest.mark.parametrize(
    "name",
    ["../escape", "/absolute", "data/../escape", "data\\escape"],
)
def test_archive_rejects_path_traversal(tmp_path: Path, name: str) -> None:
    with pytest.raises(DatasetArchiveValidationError, match="path"):
        DatasetArchiveStore(tmp_path).put(make_archive(extra={name: b"x"}), owner_connection_id="owner")


def test_archive_rejects_symlink_special_file_and_duplicate_paths(tmp_path: Path) -> None:
    symlink = zipfile.ZipInfo("data/link")
    symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        for name, content in {
            "manifest.json": make_archive(),
        }.items():
            del name, content
        valid = make_archive()
        with zipfile.ZipFile(io.BytesIO(valid)) as source:
            for info in source.infolist():
                archive.writestr(info, source.read(info.filename))
        archive.writestr(symlink, b"dataset.py")
    with pytest.raises(DatasetArchiveValidationError, match="special"):
        DatasetArchiveStore(tmp_path / "symlink").put(stream.getvalue(), owner_connection_id="owner")

    duplicate = io.BytesIO()
    with zipfile.ZipFile(duplicate, "w") as archive:
        archive.writestr("manifest.json", b"x")
        archive.writestr("manifest.json", b"y")
    with pytest.raises(DatasetArchiveValidationError, match="duplicate"):
        DatasetArchiveStore(tmp_path / "duplicate").put(duplicate.getvalue(), owner_connection_id="owner")


def test_archive_validation_never_imports_dataset_python(tmp_path: Path) -> None:
    marker = tmp_path / "imported"
    archive = make_archive(extra={"dataset.py": f"{marker!s}.write_text('bad')".encode()})
    DatasetArchiveStore(tmp_path / "store").put(archive, owner_connection_id="owner")
    assert not marker.exists()


def test_resolve_rejects_corrupt_archive_or_metadata(tmp_path: Path) -> None:
    store = DatasetArchiveStore(tmp_path)
    result = store.put(make_archive(), owner_connection_id="owner")
    reference = DatasetReference.model_validate(result["reference"])
    archive_path = store.resolve(reference, owner_connection_id="owner")
    archive_path.write_bytes(archive_path.read_bytes() + b"corrupt")
    with pytest.raises(DatasetArchiveValidationError, match="digest"):
        store.resolve(reference, owner_connection_id="owner")

    store = DatasetArchiveStore(tmp_path / "metadata")
    result = store.put(make_archive(), owner_connection_id="owner")
    reference = DatasetReference.model_validate(result["reference"])
    record_path = next((tmp_path / "metadata").rglob("*.json"))
    record = json.loads(record_path.read_text())
    record["manifest"]["id"] = "tampered"
    record_path.write_text(json.dumps(record))
    with pytest.raises(DatasetArchiveValidationError, match="metadata"):
        store.resolve(reference, owner_connection_id="owner")


def test_api_advertises_limit_and_returns_only_opaque_upload_metadata(tmp_path: Path) -> None:
    archive = make_archive()
    auth = AuthService(
        InMemoryAuthStore(),
        secret_factory=lambda: "a" * 43,
        code_factory=lambda: "123456",
    )
    grant = auth.create_pairing("test", client_host="127.0.0.1")
    auth.approve(grant.request_id)
    manager = SimpleNamespace(
        artifact_root=tmp_path / "artifacts",
        package_store=PackageStore(tmp_path / "packages"),
        executors=[],
    )
    app = create_app(manager=manager, auth_service=auth)

    async def call() -> tuple[httpx.Response, httpx.Response]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            headers = {"authorization": f"Bearer {grant.token}"}
            capabilities = await client.get("/dataset-archives/capabilities", headers=headers)
            upload = await client.post(
                "/dataset-archives",
                content=archive,
                headers={**headers, "content-type": "application/zip"},
            )
            return capabilities, upload

    capabilities, upload = asyncio.run(call())
    assert capabilities.status_code == 200
    assert capabilities.json()["max_bytes"] == 64 * 1024 * 1024
    assert upload.status_code == 201
    body = upload.json()
    assert body["reference"]["kind"] == "project"
    assert body["reference"]["ref"].startswith("dataset_")
    assert "/" not in body["reference"]["ref"]
    assert "path" not in body
