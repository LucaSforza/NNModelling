"""Tests for digest-addressed executable package persistence."""

from __future__ import annotations

import base64
import hashlib

import pytest

from backend.package_store import BundleValidationError, PackageStore


def test_package_store_round_trip_and_owner_isolation(tmp_path) -> None:
    source = "def build(parameters, context, services): return None\n"
    content = source.encode()
    bundle = {
        "manifest": {"schemaVersion": 1, "id": "demo.package", "version": "0.1.0", "dependencies": {}, "entrypoints": {"pytorch": "pytorch.py"}},
        "files": {"pytorch.py": {"content": base64.b64encode(content).decode(), "sha256": hashlib.sha256(content).hexdigest()}},
    }
    store = PackageStore(tmp_path)
    record = store.put(bundle, owner_connection_id="owner")
    assert store.get("demo.package", "0.1.0", owner_connection_id="owner")["sha256"] == record["sha256"]
    with pytest.raises(KeyError):
        store.get("demo.package", "0.1.0", owner_connection_id="other")
    with pytest.raises(ValueError):
        store.put(bundle, owner_connection_id="owner", declared_digest="0" * 64)


def test_bundle_digest_is_shared_but_acl_is_per_owner(tmp_path) -> None:
    content = b"def build(parameters, context, services): return None\n"
    package = {
        "manifest": {"schemaVersion": 1, "id": "demo.package", "version": "0.1.0", "dependencies": {}, "entrypoints": {"pytorch": "pytorch.py"}},
        "files": {"pytorch.py": {"content": base64.b64encode(content).decode(), "sha256": hashlib.sha256(content).hexdigest()}},
    }
    bundle = {"schema_version": 1, "format": "package-bundle/v1", "graph": {"nodes": [], "edges": []}, "packages": [package]}
    store = PackageStore(tmp_path)
    first = store.put_bundle(bundle, owner_connection_id="alice")
    second = store.put_bundle(bundle, owner_connection_id="bob")
    assert first["bundle_ref"] == second["bundle_ref"]
    assert store.get_bundle(first["bundle_ref"], owner_connection_id="alice")["bundle"] == bundle
    assert store.get_bundle(first["bundle_ref"], owner_connection_id="bob")["bundle"] == bundle


def test_bundle_size_limit_is_enforced_before_persistence(tmp_path) -> None:
    content = b"x" * (2 * 1024 * 1024)
    package = {
        "manifest": {"schemaVersion": 1, "id": "demo.package", "version": "0.1.0", "dependencies": {}, "entrypoints": {"pytorch": "pytorch.py"}},
        "files": {"pytorch.py": {"content": base64.b64encode(content).decode(), "sha256": hashlib.sha256(content).hexdigest()}},
    }
    bundle = {"schema_version": 1, "format": "package-bundle/v1", "graph": {}, "packages": [package]}
    with pytest.raises(BundleValidationError):
        PackageStore(tmp_path).put_bundle(bundle, owner_connection_id="owner")
    assert not list(tmp_path.rglob("*.json"))
