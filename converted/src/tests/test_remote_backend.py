"""Focused W&B controller/API lifecycle contracts."""

from __future__ import annotations

import asyncio
import hashlib
import json
import zipfile
from pathlib import Path
from typing import Any

import httpx
import pytest

from backend.app import create_app
from backend.auth import AuthService, InMemoryAuthStore
from backend.manager import JobManager, WandbUnavailableError
from backend.models import WandbRequest
from backend.store import InMemoryJobStore
from tests.backend_helpers import package_submission


OWNER = "wandb-owner"


class ControllerExecutor:
    """Small container executor double with an injectable capability status."""

    name = "container-test"
    kind = "container"

    def __init__(self, online: bool = False) -> None:
        self.online = online

    def can_run(self, resources: dict[str, Any]) -> bool:
        del resources
        return True

    def wandb_capabilities(self) -> dict[str, Any]:
        return {
            "available_modes": ["disabled", "offline"] + (["online"] if self.online else []),
            "online": {
                "configured": self.online,
                "entity": "team" if self.online else None,
                "base_url": "https://api.wandb.ai" if self.online else None,
                "reason": None if self.online else "controller unavailable",
            },
        }

    def submit(self, job: dict[str, Any], artifact_dir: str, on_heartbeat: Any, on_finished: Any) -> dict[str, Any]:
        del job, artifact_dir, on_heartbeat, on_finished
        return {"pid": 1}

    def cancel(self, job_id: str) -> bool:
        del job_id
        return True


def _submission(manager: JobManager, *, mode: str = "offline", owner: str = OWNER):
    submission = package_submission(manager, owner)
    return submission.model_copy(
        update={
            "training": submission.training.model_copy(
                update={"wandb": WandbRequest(mode=mode, project="tests")}
            )
        }
    )


def test_online_submission_is_rejected_before_job_persistence(tmp_path: Path) -> None:
    manager = JobManager(InMemoryJobStore(), tmp_path, [ControllerExecutor(online=False)])
    submission = _submission(manager, mode="online")

    with pytest.raises(WandbUnavailableError, match="controller unavailable"):
        manager.submit(submission, owner_connection_id=OWNER)

    assert manager.store.list_jobs() == []
    assert manager.wandb_capabilities() == {
        "available_modes": ["disabled", "offline"],
        "online": {
            "configured": False,
            "entity": None,
            "base_url": None,
            "reason": "controller unavailable",
        },
    }


def test_manager_publishes_structured_manifest_and_snapshots_offline_files(tmp_path: Path) -> None:
    manager = JobManager(InMemoryJobStore(), tmp_path, [ControllerExecutor()])
    queued = manager.submit(_submission(manager), owner_connection_id=OWNER)
    artifact = Path(queued.artifact_dir)
    (artifact / "wandb").mkdir()
    (artifact / "wandb" / "offline-run-1").mkdir()
    (artifact / "wandb" / "offline-run-1" / "run-1.wandb").write_bytes(b"wandb-run")
    (artifact / "wandb-run.json").write_text(
        json.dumps({
            "mode": "offline",
            "id": "offline-run-1",
            "entity": None,
            "project": "tests",
            "url": None,
        }),
        encoding="utf-8",
    )

    manager._heartbeat(queued.id, {"worker": "test"})
    status = manager.status(queued.id, owner_connection_id=OWNER)
    assert status.wandb_run is not None
    assert status.wandb_run.mode == "offline"
    ready = [event for event in manager.events(queued.id, owner_connection_id=OWNER) if event["type"] == "wandb_ready"]
    assert ready and ready[-1]["wandb_run"]["id"] == "offline-run-1"

    with pytest.raises(FileNotFoundError):
        manager.wandb_offline_download(queued.id, owner_connection_id=OWNER)
    manager._set_status(queued.id, "cancelled", finished_at="2026-01-01T00:00:00+00:00")
    snapshot, filename, digest = manager.wandb_offline_download(
        queued.id,
        owner_connection_id=OWNER,
    )
    try:
        assert filename == f"wandb-{queued.id}.zip"
        assert hashlib.sha256(snapshot.read_bytes()).hexdigest() == digest
        with zipfile.ZipFile(snapshot) as archive:
            assert archive.read("offline-run-1/run-1.wandb") == b"wandb-run"
    finally:
        snapshot.unlink(missing_ok=True)


def test_offline_download_requires_explicit_submission_mode(tmp_path: Path) -> None:
    manager = JobManager(InMemoryJobStore(), tmp_path, [ControllerExecutor()])
    queued = manager.submit(_submission(manager), owner_connection_id=OWNER)
    manager._set_status(queued.id, "cancelled", finished_at="2026-01-01T00:00:00+00:00")
    stored = manager.store.get_job(queued.id)
    assert stored is not None
    del stored["submission"]["training"]["wandb"]["mode"]
    manager.store.save_job(queued.id, stored)

    with pytest.raises(FileNotFoundError):
        manager.wandb_offline_download(queued.id, owner_connection_id=OWNER)


def test_authenticated_capability_endpoint_is_scoped(tmp_path: Path) -> None:
    auth = AuthService(InMemoryAuthStore())
    grant = auth.create_pairing("test", client_host="127.0.0.1")
    auth.approve(grant.request_id)
    manager = JobManager(InMemoryJobStore(), tmp_path, [ControllerExecutor()])
    app = create_app(manager=manager, auth_service=auth)

    async def exercise() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                headers = {"authorization": f"Bearer {grant.token}"}
                return await client.get("/capabilities", headers=headers)

    capabilities = asyncio.run(exercise())
    assert capabilities.status_code == 200
    assert capabilities.json()["available_modes"] == ["disabled", "offline"]
