"""Small package-native fixtures shared by backend service tests."""

from __future__ import annotations

from typing import Any

from backend.models import JobSubmission


def package_graph() -> dict[str, Any]:
    """Return the smallest valid graph used by lifecycle-only tests."""

    return {"nodes": [], "edges": []}


def package_submission(manager: Any, owner: str, *, package_name: str = "nnm_test") -> JobSubmission:
    """Upload a harmless package bundle and return a matching job document."""

    graph = package_graph()
    bundle = {"schema_version": 1, "format": "package-bundle/v1", "graph": graph, "packages": []}
    stored = manager.package_store.put_bundle(bundle, owner_connection_id=owner)
    return JobSubmission(
        network={"format": "package", "value": {"graph": graph, "bundle_ref": stored["bundle_ref"]}},
        training={
            "dataset": {
                "reference": {
                    "kind": "builtin",
                    "id": "builtin.mnist",
                    "version": "1.0.0",
                    "ref": "builtin_mnist",
                },
                "parameters": {},
            },
        },
        package_name=package_name,
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
