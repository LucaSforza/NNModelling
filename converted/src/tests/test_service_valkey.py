"""Service tests against a real Valkey instance.

These tests exercise the production :class:`ValkeyJobStore` and
:class:`ValkeyAuthStore` with real persistence, queue ordering, stream
cursors, atomic claims, and manager restart recovery. They require a running
Valkey: locally they are skipped when the service is absent, while
``NNM_REQUIRE_VALKEY=1`` (the required CI mode) turns absence into failure.

Run with::

    cd converted && uv run pytest src/tests/ -m service -q
"""

from __future__ import annotations

import asyncio
import json
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from backend.app import create_app
from backend.auth import AuthError, AuthService, ValkeyAuthStore
from backend.manager import JobManager
from backend.store import ValkeyJobStore
from tests.backend_helpers import get_test_valkey_url, package_submission, valkey_required


pytestmark = pytest.mark.service

OWNER = "service-connection"


def _iso(offset_minutes: int) -> str:
    """Return a tz-aware ISO timestamp offset from a fixed origin."""
    return (datetime(2026, 1, 1, tzinfo=UTC) + timedelta(minutes=offset_minutes)).isoformat()


def test_job_store_persistence_round_trip(clean_valkey):
    """Jobs saved by one store instance survive a fresh instance (restart)."""
    url = get_test_valkey_url()
    record = {
        "id": "job-1",
        "status": "queued",
        "priority": 5,
        "created_at": _iso(0),
        "artifact_dir": "/tmp/job-1",
        "owner_connection_id": OWNER,
        "resources": {"cpu": 1, "memory_gb": 1, "gpu": 0},
        "submission": {"network": {"format": "package", "value": {"graph": {"nodes": [], "edges": []}, "bundle_ref": "0" * 64}}},
    }
    first = ValkeyJobStore(url)
    first.save_job("job-1", record)

    second = ValkeyJobStore(url)
    assert second.get_job("job-1") == record
    assert [job["id"] for job in second.list_jobs()] == ["job-1"]


def test_job_store_priority_then_fifo_ordering(clean_valkey):
    """The real queue claims by priority, then by submission time."""
    store = ValkeyJobStore(get_test_valkey_url())
    store.enqueue("low", priority=1, created_at=_iso(0))
    store.enqueue("high-late", priority=10, created_at=_iso(2))
    store.enqueue("high-early", priority=10, created_at=_iso(1))

    assert store.claim_next() == "high-early"
    assert store.claim_next() == "high-late"
    assert store.claim_next() == "low"
    assert store.claim_next() is None


def test_job_store_queue_removal(clean_valkey):
    """Removing a queued job keeps it out of claim order and cleans priorities."""
    store = ValkeyJobStore(get_test_valkey_url())
    store.enqueue("keep-1", priority=10, created_at=_iso(0))
    store.enqueue("remove-me", priority=10, created_at=_iso(1))
    store.enqueue("keep-2", priority=10, created_at=_iso(2))

    store.remove_from_queue("remove-me", priority=10)

    assert store.claim_next() == "keep-1"
    assert store.claim_next() == "keep-2"
    assert store.claim_next() is None
    # The priority index is dropped when its last member is removed.
    assert clean_valkey.zscore("queue:priorities", "10") is None


def test_job_store_stream_cursor_beyond_retention(clean_valkey):
    """A real stream cursor keeps its native identity past the 1,000-event cap."""
    store = ValkeyJobStore(get_test_valkey_url())
    for sequence in range(1_000):
        store.append_event("job-1", {"sequence": sequence})

    first_batch = store.get_events("job-1")
    assert len(first_batch) == 1_000
    assert first_batch[-1]["sequence"] == 999

    for sequence in range(1_000, 1_500):
        store.append_event("job-1", {"sequence": sequence})

    following = store.get_events("job-1", after=first_batch[-1]["id"])
    assert [event["sequence"] for event in following] == list(range(1_000, 1_500))


def test_job_store_atomic_claim_never_double_assigns(clean_valkey):
    """Concurrent claims assign each queued job to exactly one worker."""
    store = ValkeyJobStore(get_test_valkey_url())
    for index in range(10):
        store.enqueue(f"job-{index}", priority=1, created_at=_iso(index))

    claimed: list[str] = []
    lock = threading.Lock()

    def worker() -> None:
        while True:
            job_id = store.claim_next()
            if job_id is None:
                return
            with lock:
                claimed.append(job_id)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert sorted(claimed) == [f"job-{index}" for index in range(10)]
    assert len(claimed) == len(set(claimed))


def test_auth_store_persistence_round_trip(clean_valkey):
    """Connections, requests, and audit events persist across store instances."""
    url = get_test_valkey_url()
    connection = {
        "id": "conn-1",
        "token_hash": "hash",
        "status": "active",
        "created_at": _iso(0),
        "expires_at": _iso(30),
    }
    request = {
        "id": "req-1",
        "connection_id": "conn-1",
        "kind": "new",
        "status": "pending",
        "verification_code": "123456",
        "client_host": "127.0.0.1",
        "created_at": _iso(0),
        "expires_at": _iso(10),
    }
    first = ValkeyAuthStore(url)
    first.save_connection("conn-1", connection)
    first.save_request("req-1", request)
    first.append_audit({"type": "pairing_requested", "connection_id": "conn-1"})

    second = ValkeyAuthStore(url)
    assert second.get_connection("conn-1") == connection
    assert second.get_request("req-1") == request
    assert [item["id"] for item in second.list_connections()] == ["conn-1"]
    assert [item["id"] for item in second.list_requests()] == ["req-1"]
    audit = clean_valkey.xrange("auth:audit")
    assert len(audit) == 1
    assert json.loads(audit[0][1]["event"])["type"] == "pairing_requested"


def test_auth_service_full_flow_on_real_valkey(clean_valkey):
    """Pairing, approval, authentication, and revocation work on Valkey."""
    store = ValkeyAuthStore(get_test_valkey_url())
    auth = AuthService(store)
    pairing = auth.create_pairing("E2E browser", client_host="127.0.0.1")

    auth.approve(pairing.request_id)

    assert auth.authenticate(pairing.token)["id"] == pairing.connection_id
    # A fresh service over a fresh store sees the same persisted session.
    restarted = AuthService(ValkeyAuthStore(get_test_valkey_url()))
    assert restarted.authenticate(pairing.token)["id"] == pairing.connection_id

    restarted.revoke(pairing.connection_id)
    with pytest.raises(AuthError, match="revoked"):
        restarted.authenticate(pairing.token)


class _NoopExecutor:
    """Executor double used only by the recovery test, which never runs jobs."""

    name = "noop"
    kind = "local"

    def can_run(self, resources):
        del resources
        return True

    def describe(self):
        return {"id": self.name, "kind": self.kind, "capacity": {}, "enabled": True}

    def submit(self, job, artifact_dir, on_heartbeat, on_finished):
        del job, artifact_dir, on_heartbeat, on_finished
        raise AssertionError("recovery tests must not run jobs")

    def cancel(self, job_id):
        del job_id
        return True


def test_manager_recovery_on_persisted_valkey_state(tmp_path, clean_valkey):
    """A restart over the same Valkey re-enqueues queued jobs and fails running ones."""
    url = get_test_valkey_url()
    executor = _NoopExecutor()
    first_manager = JobManager(ValkeyJobStore(url), tmp_path / "artifacts", [executor])
    queued = first_manager.submit(package_submission(first_manager, OWNER), owner_connection_id=OWNER)
    running = first_manager.submit(package_submission(first_manager, OWNER), owner_connection_id=OWNER)
    # Simulate a crash while the second job was executing: its persisted
    # record is flipped to "running" and the manager dies without cleanup.
    record = ValkeyJobStore(url).get_job(running.id)
    assert record is not None
    record["status"] = "running"
    ValkeyJobStore(url).save_job(running.id, record)

    restarted = JobManager(ValkeyJobStore(url), tmp_path / "artifacts", [executor])
    restarted._recover()

    still_queued = restarted.status(queued.id, owner_connection_id=OWNER)
    assert still_queued.status == "queued"
    queue_key = f"queue:priority:{queued.priority}"
    assert clean_valkey.zscore(queue_key, queued.id) is not None
    recovered = restarted.status(running.id, owner_connection_id=OWNER)
    assert recovered.status == "failed"
    assert recovered.finished_at is not None
    events = restarted.events(running.id, owner_connection_id=OWNER)
    assert events[-1]["type"] == "failed"
    assert "restarted" in (recovered.error or "")


def test_recovery_failed_job_removed_from_valkey_queue_and_contract_preserved(tmp_path, clean_valkey):
    """D5: a failed job leaves the real queue; priority buckets and index are cleaned.

    The persisted record is ``running`` while its queue entry was never
    claimed (crash between enqueue and claim). Recovery fails the job and must
    remove it from the runnable queue while keeping the record, events, and
    logs visible.
    """
    url = get_test_valkey_url()
    executor = _NoopExecutor()
    store = ValkeyJobStore(url)
    first_manager = JobManager(store, tmp_path / "artifacts", [executor])
    queued = first_manager.submit(package_submission(first_manager, OWNER), owner_connection_id=OWNER)
    record = store.get_job(queued.id)
    assert record is not None
    record["status"] = "running"
    store.save_job(queued.id, record)
    queue_key = f"queue:priority:{queued.priority}"
    assert clean_valkey.zscore(queue_key, queued.id) is not None
    assert clean_valkey.zscore("queue:priorities", str(queued.priority)) is not None

    restarted = JobManager(ValkeyJobStore(url), tmp_path / "artifacts", [executor])
    restarted._recover()

    recovered = restarted.status(queued.id, owner_connection_id=OWNER)
    assert recovered.status == "failed"
    assert recovered.finished_at is not None
    # Queue invariants: member gone, priority bucket and index cleaned, not claimable.
    assert clean_valkey.zscore(queue_key, queued.id) is None
    assert clean_valkey.zcard(queue_key) == 0
    assert clean_valkey.zscore("queue:priorities", str(queued.priority)) is None
    assert ValkeyJobStore(url).claim_next() is None
    # Visibility contracts: list/get/events/logs remain available.
    assert [job.id for job in restarted.admin_list_status()] == [queued.id]
    assert restarted.events(queued.id, owner_connection_id=OWNER)[-1]["type"] == "failed"
    assert set(restarted.admin_logs(queued.id)) == {"stdout", "stderr"}


def test_valkey_mark_failed_atomically_persists_and_dequeues(clean_valkey):
    """H1: the failed record and the queue/index removal commit together on Valkey."""
    url = get_test_valkey_url()
    store = ValkeyJobStore(url)
    record = {
        "id": "job-1",
        "status": "running",
        "priority": 10,
        "created_at": _iso(0),
        "artifact_dir": "/tmp/job-1",
        "owner_connection_id": OWNER,
        "resources": {"cpu": 1, "memory_gb": 1, "gpu": 0},
        "submission": {"network": {"format": "package", "value": {"graph": {"nodes": [], "edges": []}, "bundle_ref": "0" * 64}}},
    }
    store.save_job("job-1", record)
    store.enqueue("job-1", priority=10, created_at=_iso(0))
    assert clean_valkey.zscore("queue:priority:10", "job-1") is not None
    assert clean_valkey.zscore("queue:priorities", "10") is not None

    updated = store.mark_failed("job-1", {"finished_at": _iso(5), "error": "boom"})

    assert updated is not None
    assert updated["status"] == "failed"
    assert updated["error"] == "boom"
    assert updated["finished_at"] == _iso(5)
    # Record and queue are consistent in one atomic result.
    assert store.get_job("job-1")["status"] == "failed"
    assert clean_valkey.zscore("queue:priority:10", "job-1") is None
    assert clean_valkey.zcard("queue:priority:10") == 0
    assert clean_valkey.zscore("queue:priorities", "10") is None
    assert store.claim_next() is None


def test_valkey_mark_failed_failure_leaves_no_partial_state_and_recovery_reconciles(
    tmp_path, clean_valkey, monkeypatch
):
    """H1: a Valkey command failure on the atomic script leaves no partial state.

    The manager surfaces the failure, and a later recovery over the same
    persisted state reconciles the job to failed with the queue cleaned.
    """
    monkeypatch.setattr("backend.manager.FAILED_TRANSITION_BACKOFF_SECONDS", 0)
    url = get_test_valkey_url()
    executor = _NoopExecutor()
    store = ValkeyJobStore(url)
    manager = JobManager(store, tmp_path / "artifacts", [executor])
    queued = manager.submit(package_submission(manager, OWNER), owner_connection_id=OWNER)
    record = store.get_job(queued.id)
    assert record is not None
    record["status"] = "running"
    store.save_job(queued.id, record)
    queue_key = f"queue:priority:{queued.priority}"
    assert clean_valkey.zscore(queue_key, queued.id) is not None

    # Simulate a transport failure before the Lua script executes, on the
    # exact client the manager uses.
    with monkeypatch.context() as context:
        context.setattr(
            store.client,
            "eval",
            lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("valkey down")),
        )
        with pytest.raises(RuntimeError, match="valkey down"):
            manager._recover()

    # Atomic contract on the real store: neither record nor queue changed.
    assert ValkeyJobStore(url).get_job(queued.id)["status"] == "running"
    assert clean_valkey.zscore(queue_key, queued.id) is not None
    assert clean_valkey.zscore("queue:priorities", str(queued.priority)) is not None

    # A working store (restart) reconciles the same persisted state.
    restarted = JobManager(ValkeyJobStore(url), tmp_path / "artifacts2", [executor])
    restarted._recover()
    assert restarted.status(queued.id, owner_connection_id=OWNER).status == "failed"
    assert clean_valkey.zscore(queue_key, queued.id) is None
    assert clean_valkey.zscore("queue:priorities", str(queued.priority)) is None
    assert ValkeyJobStore(url).claim_next() is None
    assert restarted.events(queued.id, owner_connection_id=OWNER)[-1]["type"] == "failed"


class _SucceedingExecutor:
    """Executor double that reports success without writing safe weights.

    The real exporter then fails deterministically on the missing
    ``weights.safetensors``, which is exactly the D4 packaging-failure path
    this service test must exercise against the real store: no exporter is
    monkeypatched, no network is involved, and only the executor — the
    component that normally produces the weights — is a double.
    """

    name = "fake"
    kind = "container"

    def can_run(self, resources):
        del resources
        return True

    def describe(self):
        return {"id": self.name, "kind": self.kind, "capacity": {}, "enabled": True}

    def submit(self, job, artifact_dir, on_heartbeat, on_finished):
        del job, on_heartbeat
        root = Path(artifact_dir)
        (root / "stdout.log").write_text("training ok\n", encoding="utf-8")
        (root / "stderr.log").write_text("", encoding="utf-8")
        on_finished(
            0,
            {"stdout": str(root / "stdout.log"), "stderr": str(root / "stderr.log")},
        )
        return {"worker": "fake"}

    def cancel(self, job_id):
        del job_id
        return True


def test_package_export_failure_on_real_valkey_fails_job_atomically(tmp_path, clean_valkey):
    """D4 on the real store: a missing wheel output fails the job atomically.

    A job whose training finished (return code 0) but whose wheel export
    cannot run — here because the executor never wrote safe weights — must
    record a client-visible ``package_error``, emit ``package_failed`` before
    the terminal ``failed`` event, persist the failed record and the
    queue/bucket/index cleanup in the same atomic Valkey transition, keep
    job/list/events/error/logs visible to its owner, and never expose a
    downloadable package (the API answers ``404``).
    """
    url = get_test_valkey_url()
    store = ValkeyJobStore(url)
    auth = AuthService(ValkeyAuthStore(url))
    pairing = auth.create_pairing("D4 service owner", client_host="127.0.0.1")
    auth.approve(pairing.request_id)
    owner = pairing.connection_id

    manager = JobManager(store, tmp_path / "jobs", [_SucceedingExecutor()])
    queued = manager.submit(package_submission(manager, owner), owner_connection_id=owner)
    queue_key = f"queue:priority:{queued.priority}"
    assert clean_valkey.zscore(queue_key, queued.id) is not None
    assert clean_valkey.zscore("queue:priorities", str(queued.priority)) is not None

    assert manager.run_once() is True

    status = manager.status(queued.id, owner_connection_id=owner)
    assert status.status == "failed"
    assert status.finished_at is not None
    assert status.model_package is None
    assert "weights.safetensors" in (status.package_error or "")
    assert "weights.safetensors" in (status.error or "")

    # D4/D5: the failed record and the queue/bucket/index cleanup committed on
    # the real store; nothing is claimable and no manifest was ever written.
    assert store.get_job(queued.id)["status"] == "failed"
    assert clean_valkey.zscore(queue_key, queued.id) is None
    assert clean_valkey.zcard(queue_key) == 0
    assert clean_valkey.zscore("queue:priorities", str(queued.priority)) is None
    assert store.claim_next() is None
    assert not (Path(status.artifact_dir) / "model-package.json").exists()

    # Event contract: queued < running < package_failed < failed, terminal last.
    events = manager.events(queued.id, owner_connection_id=owner)
    types = [event["type"] for event in events]
    for expected in ("queued", "running", "package_failed", "failed"):
        assert expected in types, f"missing {expected!r} event in {types}"
    indices = [
        types.index("queued"),
        types.index("running"),
        types.index("package_failed"),
        types.index("failed"),
    ]
    assert indices == sorted(indices), f"events out of order: {types}"
    assert types[-1] == "failed"

    # Ownership visibility: job, list, events, error, and logs stay available.
    assert [job.id for job in manager.list_status(owner_connection_id=owner)] == [queued.id]
    assert manager.logs(queued.id, owner_connection_id=owner)["stdout"] == "training ok\n"
    assert Path(status.artifact_dir).is_dir()

    # API surface with the real auth store: the owner sees the failed job,
    # its events and logs, and the download answers 404.
    app = create_app(manager, auth_service=auth, admin_token="admin-secret")

    async def exercise_api() -> None:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                headers = {"authorization": f"Bearer {pairing.token}"}
                job_response = await client.get(f"/jobs/{queued.id}", headers=headers)
                assert job_response.status_code == 200
                body = job_response.json()
                assert body["status"] == "failed"
                assert body["model_package"] is None
                assert body["package_error"] is not None
                assert "weights.safetensors" in body["package_error"]

                listed = await client.get("/jobs", headers=headers)
                assert [job["id"] for job in listed.json()] == [queued.id]

                events_response = await client.get(f"/jobs/{queued.id}/events", headers=headers)
                assert events_response.status_code == 200
                event_types = [
                    json.loads(line.removeprefix("data: "))["type"]
                    for line in events_response.text.splitlines()
                    if line.startswith("data: ")
                ]
                for expected in ("queued", "running", "package_failed", "failed"):
                    assert expected in event_types, f"missing {expected!r} event in {event_types}"
                indices = [
                    event_types.index("queued"),
                    event_types.index("running"),
                    event_types.index("package_failed"),
                    event_types.index("failed"),
                ]
                assert indices == sorted(indices), f"events out of order: {event_types}"
                assert event_types[-1] == "failed"

                logs = await client.get(f"/jobs/{queued.id}/logs", headers=headers)
                assert logs.status_code == 200
                assert logs.json()["stdout"] == "training ok\n"

                package = await client.get(f"/jobs/{queued.id}/package", headers=headers)
                assert package.status_code == 404

    asyncio.run(exercise_api())


def test_required_valkey_mode_flag_reflects_environment(clean_valkey, monkeypatch):
    """The required CI mode hook must react to its environment variable."""
    monkeypatch.setenv("NNM_REQUIRE_VALKEY", "1")
    assert valkey_required()
    monkeypatch.setenv("NNM_REQUIRE_VALKEY", "0")
    assert not valkey_required()
