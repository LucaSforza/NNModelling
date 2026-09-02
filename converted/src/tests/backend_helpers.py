"""Small package-native fixtures shared by backend service tests."""

from __future__ import annotations

import io
import json
from typing import Any
import zipfile

from backend.models import JobSubmission


def package_graph() -> dict[str, Any]:
    """Return the smallest valid graph used by lifecycle-only tests."""

    return {"nodes": [], "edges": []}


def package_submission(manager: Any, owner: str) -> JobSubmission:
    """Upload harmless package and dataset bundles for lifecycle tests."""

    graph = package_graph()
    bundle = {"schema_version": 1, "format": "package-bundle/v1", "graph": graph, "packages": []}
    stored = manager.package_store.put_bundle(bundle, owner_connection_id=owner)
    dataset_files = {
        "manifest.json": json.dumps({
            "schemaVersion": 1,
            "id": "demo.dataset",
            "version": "1.0.0",
            "entrypoints": {"definition": "dataset.json", "python": "dataset.py"},
        }).encode(),
        "dataset.json": json.dumps({
            "schemaVersion": 1,
            "id": "demo.dataset",
            "version": "1.0.0",
            "name": "Demo dataset",
            "parameters": [],
            "batch": {"inputs": {}, "targets": {}},
        }).encode(),
        "dataset.py": b"def build(parameters, context): raise RuntimeError('test only')\n",
        "data/marker": b"test",
    }
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
        for filename, content in dataset_files.items():
            archive.writestr(filename, content)
    dataset = manager.dataset_store.put(stream.getvalue(), owner_connection_id=owner)
    return JobSubmission(
        network={"format": "package", "value": {"graph": graph, "bundle_ref": stored["bundle_ref"]}},
        training={
            "dataset": {
                "reference": dataset["reference"],
                "parameters": {},
            },
        },
    )


def classification_submission(*args: Any, **kwargs: Any) -> JobSubmission:
    """Compatibility shim for service tests; callers must bind a manager."""

    del args, kwargs
    raise TypeError("use package_submission(manager, owner) in package-native tests")


def get_test_valkey_url() -> str:
    import os

    return os.getenv("NNM_VALKEY_URL", "valkey://127.0.0.1:6379/15")


def valkey_required() -> bool:
    import os

    return os.getenv("NNM_REQUIRE_VALKEY", "0").lower() in {"1", "true", "yes"}
