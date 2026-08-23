"""Tests for digest-addressed executable package persistence."""

from __future__ import annotations

import base64
import hashlib

import pytest

from backend.package_store import PackageStore


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
