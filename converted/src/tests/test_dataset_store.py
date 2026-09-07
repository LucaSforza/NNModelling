"""Security and ownership coverage for project dataset archive storage."""

from __future__ import annotations

import io
import json
import stat
import zipfile
import asyncio
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest

from backend.app import create_app
from backend.auth import AuthService, InMemoryAuthStore
from backend.cli import _dataset_limits, build_parser, main
from backend.config import dataset_limits_from_environment, parse_dataset_size
from backend.dataset_store import (
    MAX_DATASET_ARCHIVE_BYTES,
    MAX_DATASET_FILES,
    DatasetArchiveLimits,
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
            "parameters": [{"name": "B", "type": "integer", "required": True}],
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


def test_default_dataset_limits_remain_unchanged() -> None:
    limits = DatasetArchiveLimits()
    assert limits.max_archive_bytes == 64 * 1024 * 1024
    assert limits.max_file_bytes == 16 * 1024 * 1024
    assert limits.max_uncompressed_bytes == 64 * 1024 * 1024
    assert limits.max_files == 2048


@pytest.mark.parametrize(
    ("value", "expected"),
    [("7B", 7), ("2KiB", 2 * 1024), ("3MiB", 3 * 1024**2), ("4GiB", 4 * 1024**3)],
)
def test_parse_dataset_size_units(value: str, expected: int) -> None:
    assert parse_dataset_size(value) == expected


@pytest.mark.parametrize("value", ["0B", "-1MiB", "1MB", "MiB", "1.5GiB", "nonsense"])
def test_parse_dataset_size_rejects_nonpositive_or_invalid_values(value: str) -> None:
    with pytest.raises(ValueError, match="positive integer"):
        parse_dataset_size(value)


def test_cli_size_modes_are_mutually_exclusive_and_override_environment() -> None:
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["--max-dataset-size", "1MiB", "--unsafe-unlimited-dataset-size"])

    environment_limits = dataset_limits_from_environment({"NNM_DATASET_MAX_ARCHIVE_BYTES": "123"})
    assert environment_limits.max_archive_bytes == 123
    assert environment_limits.max_file_bytes == 16 * 1024 * 1024
    assert _dataset_limits(256 * 1024**2, False) == DatasetArchiveLimits.uniform_size_limit(256 * 1024**2)
    assert _dataset_limits(None, True) == DatasetArchiveLimits.unsafe_unlimited_size()


@pytest.mark.parametrize("value", ["0", "-1", "invalid"])
def test_legacy_environment_limit_rejects_invalid_values(value: str) -> None:
    with pytest.raises(ValueError, match="positive integer"):
        dataset_limits_from_environment({"NNM_DATASET_MAX_ARCHIVE_BYTES": value})


def test_cli_configures_the_application(monkeypatch: pytest.MonkeyPatch) -> None:
    run = Mock()
    monkeypatch.setattr("backend.cli.uvicorn.run", run)
    main(["--max-dataset-size", "256MiB", "--host", "127.0.0.2", "--port", "8123"])
    configured_app = run.call_args.args[0]
    assert configured_app.state.dataset_store.limits == DatasetArchiveLimits.uniform_size_limit(256 * 1024**2)
    assert configured_app.state.manager.dataset_store is configured_app.state.dataset_store
    assert run.call_args.kwargs == {"host": "127.0.0.2", "port": 8123}


def test_parameter_validation_rejects_nonpositive_dimension_values(tmp_path: Path) -> None:
    store = DatasetArchiveStore(tmp_path)
    uploaded = store.put(make_archive(), owner_connection_id="owner")
    reference = DatasetReference.model_validate(uploaded["reference"])
    with pytest.raises(DatasetArchiveValidationError, match="invalid-dimension-value"):
        store.validate_parameters(reference, {"B": 0}, owner_connection_id="owner")


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


def test_unsafe_unlimited_accepts_archive_beyond_default_size(tmp_path: Path) -> None:
    archive = make_archive(extra={"data/large.bin": b"x" * (MAX_DATASET_ARCHIVE_BYTES + 1)})
    assert len(archive) > MAX_DATASET_ARCHIVE_BYTES
    store = DatasetArchiveStore(tmp_path, limits=DatasetArchiveLimits.unsafe_unlimited_size())
    result = store.put(archive, owner_connection_id="owner")
    assert result["size"] == len(archive)
    assert result["limit"] is None


def test_unsafe_unlimited_retains_archive_safety_validation(tmp_path: Path) -> None:
    limits = DatasetArchiveLimits.unsafe_unlimited_size()

    with pytest.raises(DatasetArchiveValidationError, match="path"):
        DatasetArchiveStore(tmp_path / "traversal", limits=limits).put(
            make_archive(extra={"../escape": b"x"}), owner_connection_id="owner"
        )

    symlink = zipfile.ZipInfo("data/link")
    symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
    symlink_stream = io.BytesIO()
    with zipfile.ZipFile(symlink_stream, "w") as archive:
        with zipfile.ZipFile(io.BytesIO(make_archive())) as source:
            for info in source.infolist():
                archive.writestr(info, source.read(info.filename))
        archive.writestr(symlink, b"dataset.py")
    with pytest.raises(DatasetArchiveValidationError, match="special"):
        DatasetArchiveStore(tmp_path / "symlink", limits=limits).put(
            symlink_stream.getvalue(), owner_connection_id="owner"
        )

    duplicate = io.BytesIO()
    with zipfile.ZipFile(duplicate, "w") as archive:
        archive.writestr("manifest.json", b"x")
        archive.writestr("manifest.json", b"y")
    with pytest.raises(DatasetArchiveValidationError, match="duplicate"):
        DatasetArchiveStore(tmp_path / "duplicate", limits=limits).put(
            duplicate.getvalue(), owner_connection_id="owner"
        )

    too_many = io.BytesIO()
    with zipfile.ZipFile(too_many, "w") as archive:
        for index in range(MAX_DATASET_FILES + 1):
            archive.writestr(f"data/{index}", b"")
    with pytest.raises(DatasetArchiveValidationError, match="too many files"):
        DatasetArchiveStore(tmp_path / "files", limits=limits).put(
            too_many.getvalue(), owner_connection_id="owner"
        )

    with pytest.raises(DatasetArchiveValidationError, match="metadata"):
        DatasetArchiveStore(tmp_path / "metadata", limits=limits).put(
            make_archive(extra={"dataset.json": b"{}"}), owner_connection_id="owner"
        )


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
    assert body["limit"] == 64 * 1024 * 1024


def test_app_factory_shares_configured_store_and_unlimited_capabilities(tmp_path: Path) -> None:
    auth = AuthService(
        InMemoryAuthStore(),
        secret_factory=lambda: "b" * 43,
        code_factory=lambda: "654321",
    )
    grant = auth.create_pairing("test", client_host="127.0.0.1")
    auth.approve(grant.request_id)
    manager = SimpleNamespace(
        artifact_root=tmp_path / "artifacts",
        package_store=PackageStore(tmp_path / "packages"),
        dataset_store=DatasetArchiveStore(tmp_path / "old-datasets"),
        executors=[],
    )
    limits = DatasetArchiveLimits.unsafe_unlimited_size()
    app = create_app(manager=manager, auth_service=auth, dataset_limits=limits)
    assert app.state.dataset_store.limits == limits
    assert manager.dataset_store is app.state.dataset_store

    async def call() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.get(
                "/dataset-archives/capabilities",
                headers={"authorization": f"Bearer {grant.token}"},
            )

    response = asyncio.run(call())
    assert response.status_code == 200
    assert response.json() == {"format": "zip", "max_bytes": None}


def test_app_factory_enforces_configured_streaming_limit_before_publication(tmp_path: Path) -> None:
    auth = AuthService(
        InMemoryAuthStore(),
        secret_factory=lambda: "c" * 43,
        code_factory=lambda: "111111",
    )
    grant = auth.create_pairing("test", client_host="127.0.0.1")
    auth.approve(grant.request_id)
    manager = SimpleNamespace(
        artifact_root=tmp_path / "artifacts",
        package_store=PackageStore(tmp_path / "packages"),
        executors=[],
    )
    app = create_app(
        manager=manager,
        auth_service=auth,
        dataset_limits=DatasetArchiveLimits.uniform_size_limit(128),
    )

    async def call() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.post(
                "/dataset-archives",
                content=make_archive(),
                headers={
                    "authorization": f"Bearer {grant.token}",
                    "content-type": "application/zip",
                },
            )

    response = asyncio.run(call())
    assert response.status_code == 413
    assert response.json()["detail"]["max_bytes"] == 128
    assert not list((tmp_path / "artifacts" / "datasets").rglob("*.zip"))
