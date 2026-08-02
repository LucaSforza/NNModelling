"""Tests for remote job configuration, storage, scheduling and API wiring."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

from backend.app import create_app
from backend.auth import AuthService, InMemoryAuthStore, PairingGrant
from backend.config_service import build_job_hydra_configs, normalize_training_config
from backend.dataset_registry import discover_datasets
from backend.executors import LocalExecutor, SlurmExecutor
from backend.manager import JobManager
from backend.models import JobStatus, JobSubmission, ResourceRequest
from backend.project_env import project_python
from backend.project_schema import EnvironmentState, ProjectSummary, WandbSettings
from backend.projects import ProjectError
from backend.store import InMemoryJobStore, ValkeyJobStore


TRANSFORMER_NNTREE_PATH = Path(__file__).resolve().parents[3] / "examples" / "nntrees" / "transformer_classifier.json"
OWNER = "test-connection"


def transformer_nntree() -> dict[str, Any]:
    """Load the repository's verified transformer NNTree fixture."""

    return json.loads(TRANSFORMER_NNTREE_PATH.read_text(encoding="utf-8"))


def submission() -> JobSubmission:
    """Build a minimal valid job request."""

    return JobSubmission(
        network={"format": "nntree", "value": transformer_nntree()},
        training={
            "dataset": "dataset.enron_spam.EnronSpamDataset",
            "optimizer": {"_target_": "torch.optim.Adam", "lr": 0.01},
            "trainer": {"max_epochs": 1, "accelerator": "cpu"},
            "wandb": {"project": "tests", "mode": "disabled"},
            "early_stopping": {"patience": 1, "min_delta": 0.0},
            "overrides": ["trainer.max_epochs=2"],
        },
        resources=ResourceRequest(cpu=1, memory_gb=1, gpu=0),
        priority=10,
    )


class ImmediateExecutor:
    """Executor double that finishes successfully in the callback."""

    name = "fake"
    kind = "local"

    def can_run(self, resources: dict[str, Any]) -> bool:
        return True

    def describe(self) -> dict[str, Any]:
        return {
            "id": self.name,
            "kind": self.kind,
            "capacity": ResourceRequest(cpu=8, memory_gb=16).model_dump(mode="json"),
            "enabled": True,
        }

    def submit(self, job, artifact_dir, on_heartbeat, on_finished, project=None):
        del project
        Path(artifact_dir, "stdout.log").write_text("ok\n", encoding="utf-8")
        Path(artifact_dir, "stderr.log").write_text("", encoding="utf-8")
        on_heartbeat({"worker": "test"})
        on_finished(0, {"stdout": str(Path(artifact_dir, "stdout.log"))})
        return {"worker": "test"}

    def cancel(self, job_id: str) -> bool:
        return True


def _write_fake_wheel_manifest(
    artifact_dir: str | Path,
    *,
    package_name: str,
    version: str = "0.1.0",
) -> Path:
    """Write a fake wheel and its manifest into an artifact directory."""
    root = Path(artifact_dir)
    wheel = root / "dist" / "model.whl"
    wheel.parent.mkdir()
    wheel.write_bytes(b"wheel")
    (root / "model-package.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "package_name": package_name,
                "version": version,
                "wheel": "dist/model.whl",
                "sha256": hashlib.sha256(b"wheel").hexdigest(),
                "input_adapter": {"kind": "tensor", "version": 1},
            }
        ),
        encoding="utf-8",
    )
    return wheel


@pytest.fixture()
def packaged_export(monkeypatch):
    """Monkeypatch the wheel exporter so a finished job exports successfully."""

    def fake_export(artifact_dir, *, package_name, version="0.1.0"):
        return _write_fake_wheel_manifest(artifact_dir, package_name=package_name, version=version)

    monkeypatch.setattr("backend.manager.build_model_wheel", fake_export)


def test_normalize_training_config_accepts_dataset_target_string():
    normalized = normalize_training_config({"dataset": "dataset.mnist.MNISTDataset"})
    assert normalized["dataset"] == {"_target_": "dataset.mnist.MNISTDataset"}


def test_job_submission_requires_an_nnm_prefixed_package_name():
    payload = submission().model_dump(mode="json")
    payload["package_name"] = "classifier"

    with pytest.raises(ValueError, match="nnm_"):
        JobSubmission.model_validate(payload)


def test_dataset_registry_discovers_installed_classes():
    datasets = {item.target: item for item in discover_datasets()}
    assert datasets["dataset.mnist.MNISTDataset"].num_classes == 10
    assert datasets["dataset.enron_spam.EnronSpamDataset"].num_classes == 2
    assert datasets["dataset.autoencoder_mnist.AutoencoderMNIST"].num_classes is None


def test_job_config_uses_dataset_class_count_when_request_omits_it(tmp_path):
    job = submission().model_dump(mode="json")

    config_dir = build_job_hydra_configs(job, tmp_path)

    net = (config_dir / "net" / "custom_sequence.yaml").read_text(encoding="utf-8")
    assert "num_classes: 2" in net
    assert "class_names:" in net
    assert "- ham" in net
    assert "- spam" in net


def test_in_memory_store_orders_priority_then_fifo():
    store = InMemoryJobStore()
    store.enqueue("low", priority=1, created_at="2026-01-01T00:00:00+00:00")
    store.enqueue("high-late", priority=10, created_at="2026-01-01T00:02:00+00:00")
    store.enqueue("high-early", priority=10, created_at="2026-01-01T00:01:00+00:00")
    assert store.claim_next() == "high-early"
    assert store.claim_next() == "high-late"
    assert store.claim_next() == "low"


def test_valkey_event_cursor_continues_after_retention_limit():
    """A stream cursor must keep its native identity after 1,000 events."""

    class FakeStreamClient:
        def __init__(self) -> None:
            self.events: list[tuple[str, dict[str, str]]] = []

        def xadd(self, _key, fields, maxlen):
            event_id = f"{len(self.events) + 1}-0"
            self.events.append((event_id, fields))
            self.events = self.events[-maxlen:]
            return event_id

        def xrange(self, _key, min="-", max="+", count=None):
            del max
            events = self.events
            if min.startswith("("):
                after = tuple(int(part) for part in min[1:].split("-"))
                events = [
                    event
                    for event in events
                    if tuple(int(part) for part in event[0].split("-")) > after
                ]
            return events[:count]

    store = object.__new__(ValkeyJobStore)
    store.client = FakeStreamClient()
    for sequence in range(1_000):
        store.append_event("job-1", {"sequence": sequence})

    first_batch = store.get_events("job-1")
    assert first_batch[-1]["id"] == "1000-0"

    store.append_event("job-1", {"sequence": 1_000})
    following_batch = store.get_events("job-1", after=first_batch[-1]["id"])
    assert [event["sequence"] for event in following_batch] == [1_000]


def test_manager_builds_job_artifacts_and_finishes(tmp_path, packaged_export):
    manager = JobManager(InMemoryJobStore(), tmp_path, [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    assert queued.status == "queued"
    # A current successful job writes safe weights before packaging.
    Path(queued.artifact_dir, "weights.safetensors").write_bytes(b"safe-weights")
    assert manager.run_once() is True
    finished = manager.status(queued.id, owner_connection_id=OWNER)
    assert finished.status == "succeeded"
    assert Path(finished.artifact_dir, "requested_config.json").exists()
    assert Path(finished.artifact_dir, "resolved_config.yaml").exists()
    resolved = Path(finished.artifact_dir, "resolved_config.yaml").read_text(encoding="utf-8")
    assert "max_epochs: 2" in resolved
    assert "dataset.enron_spam.EnronSpamDataset" in resolved
    assert manager.logs(queued.id, owner_connection_id=OWNER)["stdout"] == "ok\n"


def test_manager_exports_a_model_wheel_after_a_successful_job(tmp_path, packaged_export):
    manager = JobManager(InMemoryJobStore(), tmp_path, [ImmediateExecutor()])
    queued = manager.submit(
        submission().model_copy(update={"package_name": "nnm_mnist_classifier"}),
        owner_connection_id=OWNER,
    )
    Path(queued.artifact_dir, "weights.safetensors").write_bytes(b"safe-weights")

    manager.run_once()

    status = manager.status(queued.id, owner_connection_id=OWNER)
    assert status.status == "succeeded"
    assert status.model_package is not None
    assert status.model_package.package_name == "nnm_mnist_classifier"
    events = manager.events(queued.id, owner_connection_id=OWNER)
    types = [event["type"] for event in events]
    assert any(event["type"] == "package_ready" for event in events)
    assert "succeeded" in types
    assert types.index("package_ready") < types.index("succeeded")


def test_manager_tails_only_new_log_bytes_and_resets_a_stale_offset(tmp_path):
    """Log viewers receive bounded incremental output rather than whole files."""

    manager = JobManager(InMemoryJobStore(), tmp_path, [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    root = Path(manager.status(queued.id, owner_connection_id=OWNER).artifact_dir)
    (root / "stdout.log").write_text("first\nsecond\n", encoding="utf-8")
    (root / "stderr.log").write_text("warning\n", encoding="utf-8")

    first = manager.tail_logs(queued.id, owner_connection_id=OWNER, stdout_after=0, stderr_after=0)
    assert first == {
        "stdout": {"text": "first\nsecond\n", "offset": 13, "reset": False},
        "stderr": {"text": "warning\n", "offset": 8, "reset": False},
    }

    (root / "stdout.log").write_text("first\nsecond\nthird\n", encoding="utf-8")
    appended = manager.tail_logs(
        queued.id,
        owner_connection_id=OWNER,
        stdout_after=first["stdout"]["offset"],
        stderr_after=first["stderr"]["offset"],
    )
    assert appended["stdout"] == {"text": "third\n", "offset": 19, "reset": False}
    assert appended["stderr"] == {"text": "", "offset": 8, "reset": False}

    reset = manager.tail_logs(queued.id, owner_connection_id=OWNER, stdout_after=99, stderr_after=99)
    assert reset["stdout"]["text"] == "first\nsecond\nthird\n"
    assert reset["stdout"]["reset"] is True
    assert reset["stderr"]["reset"] is True


def test_manager_publishes_wandb_url_as_soon_as_a_heartbeat_sees_it(tmp_path):
    manager = JobManager(InMemoryJobStore(), tmp_path, [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    root = Path(manager.status(queued.id, owner_connection_id=OWNER).artifact_dir)
    (root / "stdout.log").write_text("W&B URL: https://wandb.ai/team/project/runs/live-run\n", encoding="utf-8")

    manager._heartbeat(queued.id, {"worker": "test"})

    status = manager.status(queued.id, owner_connection_id=OWNER)
    assert status.wandb_url == "https://wandb.ai/team/project/runs/live-run"
    assert manager.events(queued.id, owner_connection_id=OWNER)[-1]["type"] == "heartbeat"
    assert any(
        event["type"] == "wandb_ready" and event["wandb_url"] == status.wandb_url
        for event in manager.events(queued.id, owner_connection_id=OWNER)
    )


def test_manager_publishes_wandb_url_when_a_short_job_finishes_before_heartbeat(tmp_path, packaged_export):
    class WandbImmediateExecutor(ImmediateExecutor):
        def submit(self, job, artifact_dir, on_heartbeat, on_finished):
            stdout = Path(artifact_dir, "stdout.log")
            stdout.write_text("W&B URL: https://wandb.ai/team/project/runs/quick-run\n", encoding="utf-8")
            on_finished(0, {"stdout": str(stdout)})
            return {"worker": "test"}

    manager = JobManager(InMemoryJobStore(), tmp_path, [WandbImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    Path(queued.artifact_dir, "weights.safetensors").write_bytes(b"safe-weights")

    manager.run_once()

    assert manager.status(queued.id, owner_connection_id=OWNER).status == "succeeded"
    assert any(
        event["type"] == "wandb_ready"
        and event["wandb_url"] == "https://wandb.ai/team/project/runs/quick-run"
        for event in manager.events(queued.id, owner_connection_id=OWNER)
    )


def test_manager_skips_incompatible_high_priority_job(tmp_path, packaged_export):
    """A blocked high-priority job must not starve a runnable lower-priority job."""

    class CpuOnlyExecutor(ImmediateExecutor):
        def can_run(self, resources: dict[str, Any]) -> bool:
            return ResourceRequest.model_validate(resources).gpu == 0

    manager = JobManager(InMemoryJobStore(), tmp_path, [CpuOnlyExecutor()])
    blocked = manager.submit(
        submission().model_copy(
            update={"priority": 10, "resources": ResourceRequest(cpu=1, memory_gb=1, gpu=1)}
        ),
        owner_connection_id=OWNER,
    )
    runnable = manager.submit(
        submission().model_copy(
            update={"priority": 1, "resources": ResourceRequest(cpu=1, memory_gb=1, gpu=0)}
        ),
        owner_connection_id=OWNER,
    )
    Path(runnable.artifact_dir, "weights.safetensors").write_bytes(b"safe-weights")

    assert manager.run_once() is True
    assert manager.status(blocked.id, owner_connection_id=OWNER).status == "queued"
    assert manager.status(runnable.id, owner_connection_id=OWNER).status == "succeeded"


def test_manager_stop_cancels_active_job_and_marks_it_failed(tmp_path):
    """Graceful shutdown must not leave an executor process orphaned."""

    class BlockingExecutor(ImmediateExecutor):
        def __init__(self) -> None:
            self.cancelled_job_ids: list[str] = []

        def submit(self, job, artifact_dir, on_heartbeat, on_finished):
            del artifact_dir, on_heartbeat, on_finished
            return {"job_id": job["id"]}

        def cancel(self, job_id: str) -> bool:
            self.cancelled_job_ids.append(job_id)
            return True

    executor = BlockingExecutor()
    manager = JobManager(InMemoryJobStore(), tmp_path, [executor])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    assert manager.run_once() is True
    assert manager.status(queued.id, owner_connection_id=OWNER).status == "running"

    manager.stop()

    stopped = manager.status(queued.id, owner_connection_id=OWNER)
    assert executor.cancelled_job_ids == [queued.id]
    assert stopped.status == "failed"
    assert stopped.finished_at is not None


def test_manager_recovery_records_terminal_event_for_interrupted_job(tmp_path):
    """Restart recovery must leave a complete terminal audit trail."""

    store = InMemoryJobStore()
    manager = JobManager(store, tmp_path, [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    record = store.get_job(queued.id)
    assert record is not None
    record["status"] = "running"
    store.save_job(queued.id, record)

    manager._recover()

    recovered = manager.status(queued.id, owner_connection_id=OWNER)
    assert recovered.status == "failed"
    assert recovered.finished_at is not None
    assert manager.events(queued.id, owner_connection_id=OWNER)[-1]["type"] == "failed"


def test_recovery_failed_job_is_removed_from_queue_and_contract_preserved(tmp_path):
    """D5: a failed job must not remain claimable; metadata/events/logs stay.

    A crash after enqueue but before the claim persisted leaves the record
    marked ``running`` with its queue entry still present. Recovery fails the
    job and must clean the queue entry without deleting the job or its audit
    trail.
    """

    store = InMemoryJobStore()
    manager = JobManager(store, tmp_path, [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    record = store.get_job(queued.id)
    assert record is not None
    record["status"] = "running"
    store.save_job(queued.id, record)
    assert queued.id in store.queue

    manager._recover()

    recovered = manager.status(queued.id, owner_connection_id=OWNER)
    assert recovered.status == "failed"
    assert recovered.finished_at is not None
    # Queue invariants: entry removed, not claimable, nothing left to drain.
    assert store.queue == {}
    assert store.claim_next() is None
    # Visibility contracts: list/get/events/logs remain available.
    assert [job.id for job in manager.list_status(owner_connection_id=OWNER)] == [queued.id]
    assert manager.events(queued.id, owner_connection_id=OWNER)[-1]["type"] == "failed"
    assert manager.logs(queued.id, owner_connection_id=OWNER) == {"stdout": "", "stderr": ""}


def test_recovery_keeps_queued_jobs_claimable(tmp_path):
    """D5: recovery re-enqueues queued jobs; only failed jobs leave the queue."""

    store = InMemoryJobStore()
    manager = JobManager(store, tmp_path, [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    assert queued.id in store.queue

    manager._recover()

    assert manager.status(queued.id, owner_connection_id=OWNER).status == "queued"
    assert store.claim_next() == queued.id


def test_failed_job_is_not_claimable_after_executor_failure(tmp_path):
    """D5: the real execution failure path leaves no claimable queue entry."""

    class FailingExecutor(ImmediateExecutor):
        name = "failing"

        def submit(self, job, artifact_dir, on_heartbeat, on_finished):
            stdout = Path(artifact_dir, "stdout.log")
            stderr = Path(artifact_dir, "stderr.log")
            stdout.write_text("started\n", encoding="utf-8")
            stderr.write_text("Traceback\nboom\n", encoding="utf-8")
            on_finished(1, {"stdout": str(stdout), "stderr": str(stderr)})
            return {"stdout": str(stdout), "stderr": str(stderr)}

    store = InMemoryJobStore()
    manager = JobManager(store, tmp_path, [FailingExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    assert queued.id in store.queue

    assert manager.run_once() is True

    failed = manager.status(queued.id, owner_connection_id=OWNER)
    assert failed.status == "failed"
    assert store.queue == {}
    assert store.claim_next() is None
    assert manager.logs(queued.id, owner_connection_id=OWNER)["stderr"] == "Traceback\nboom\n"


class _StatusRecordingStore(InMemoryJobStore):
    """In-memory store that records every persisted status transition."""

    def __init__(self) -> None:
        super().__init__()
        self.saved_statuses: list[str] = []

    def save_job(self, job_id, data):
        self.saved_statuses.append(data["status"])
        super().save_job(job_id, data)

    def mark_failed(self, job_id, changes):
        updated = super().mark_failed(job_id, changes)
        if updated is not None:
            self.saved_statuses.append(updated["status"])
        return updated


def test_package_failure_never_persists_a_succeeded_status(tmp_path, monkeypatch):
    """D4: a packaging failure must never persist a transient succeeded status."""

    def exploding_export(artifact_dir, *, package_name, version):
        del artifact_dir, package_name, version
        raise RuntimeError("exporter crashed")

    monkeypatch.setattr("backend.manager.build_model_wheel", exploding_export)
    store = _StatusRecordingStore()
    manager = JobManager(store, tmp_path, [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    Path(queued.artifact_dir, "weights.safetensors").write_bytes(b"safe-weights")

    manager.run_once()

    assert manager.status(queued.id, owner_connection_id=OWNER).status == "failed"
    assert store.saved_statuses[-1] == "failed"
    assert "succeeded" not in store.saved_statuses


def test_happy_path_persists_succeeded_only_after_successful_export(tmp_path, packaged_export):
    """D4: the happy chain persists running, then succeeded after package_ready."""
    store = _StatusRecordingStore()
    manager = JobManager(store, tmp_path, [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    Path(queued.artifact_dir, "weights.safetensors").write_bytes(b"safe-weights")

    manager.run_once()

    status = manager.status(queued.id, owner_connection_id=OWNER)
    assert status.status == "succeeded"
    assert status.model_package is not None
    assert store.saved_statuses[-1] == "succeeded"
    events = manager.events(queued.id, owner_connection_id=OWNER)
    types = [event["type"] for event in events]
    assert "succeeded" in types
    assert types.index("package_ready") < types.index("succeeded")


def test_synchronous_executor_emits_running_before_terminal_success(tmp_path, packaged_export):
    """P1: an immediate executor must not emit running after the terminal chain.

    ``ImmediateExecutor`` invokes ``on_finished`` inside ``submit()``, so the
    ``package_ready``/``succeeded`` events are persisted and emitted before
    ``submit()`` returns. The manager must emit ``running`` before invoking
    the executor and must not append a stale ``running`` event after the
    terminal transition, write executor details into the terminal record, or
    register the finished job as active.
    """
    store = InMemoryJobStore()
    manager = JobManager(store, tmp_path, [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    Path(queued.artifact_dir, "weights.safetensors").write_bytes(b"safe-weights")

    assert manager.run_once() is True

    assert manager.status(queued.id, owner_connection_id=OWNER).status == "succeeded"
    events = manager.events(queued.id, owner_connection_id=OWNER)
    types = [event["type"] for event in events]
    for expected in ("queued", "running", "package_ready", "succeeded"):
        assert expected in types, f"missing {expected!r} event in {types}"
    indices = [
        types.index("queued"),
        types.index("running"),
        types.index("package_ready"),
        types.index("succeeded"),
    ]
    assert indices == sorted(indices), f"events out of order: {types}"
    assert types[-1] == "succeeded"
    # The terminal record is never rewritten with executor details and the
    # finished job is not tracked as an active execution.
    assert queued.id not in manager._active
    record = store.get_job(queued.id)
    assert record is not None
    assert "executor_details" not in record


def test_synchronous_executor_package_failure_ends_terminal_with_failed(tmp_path, monkeypatch):
    """P1: an immediate executor whose package export fails ends with failed last.

    The ``package_failed``/``failed`` events are emitted inside ``submit()``;
    the manager must still emit ``running`` before the executor ran and must
    never emit a stale ``running`` event after the terminal transition.
    """

    def exploding_export(artifact_dir, *, package_name, version):
        del artifact_dir, package_name, version
        raise RuntimeError("exporter crashed")

    monkeypatch.setattr("backend.manager.build_model_wheel", exploding_export)
    store = InMemoryJobStore()
    manager = JobManager(store, tmp_path, [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    Path(queued.artifact_dir, "weights.safetensors").write_bytes(b"safe-weights")

    assert manager.run_once() is True

    assert manager.status(queued.id, owner_connection_id=OWNER).status == "failed"
    events = manager.events(queued.id, owner_connection_id=OWNER)
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
    assert queued.id not in manager._active
    record = store.get_job(queued.id)
    assert record is not None
    assert "executor_details" not in record


class _FailingMarkFailedStore(InMemoryJobStore):
    """In-memory store whose atomic failed transition always raises."""

    def mark_failed(self, job_id, changes):
        del job_id, changes
        raise RuntimeError("injected persistence failure")


class _FlakyMarkFailedStore(InMemoryJobStore):
    """In-memory store whose atomic failed transition fails N times first."""

    def __init__(self, failures_before_success: int) -> None:
        super().__init__()
        self.remaining = failures_before_success

    def mark_failed(self, job_id, changes):
        if self.remaining > 0:
            self.remaining -= 1
            raise RuntimeError("injected transient persistence failure")
        return super().mark_failed(job_id, changes)


class _PassiveExecutor:
    """Executor double that never reports completion on its own."""

    name = "passive"
    kind = "local"

    def can_run(self, resources):
        del resources
        return True

    def describe(self):
        return {"id": self.name, "kind": self.kind, "capacity": {}, "enabled": True}

    def submit(self, job, artifact_dir, on_heartbeat, on_finished):
        del job, artifact_dir, on_heartbeat, on_finished
        return {"passive": True}

    def cancel(self, job_id):
        del job_id
        return True


def _recover_with_working_store(record, tmp_path, *, owner=OWNER):
    """Simulate a restart: a fresh manager over a fresh working store."""
    working = InMemoryJobStore()
    working.save_job(record["id"], record)
    working.enqueue(record["id"], int(record["priority"]), record["created_at"])
    manager = JobManager(working, tmp_path, [ImmediateExecutor()])
    manager._recover()
    return manager, working


def test_recovery_store_failure_leaves_no_partial_state(tmp_path, monkeypatch):
    """H1: a failed atomic transition must leave neither failed+queued nor
    dequeued+running state, and the manager must surface the failure."""

    monkeypatch.setattr("backend.manager.FAILED_TRANSITION_BACKOFF_SECONDS", 0)
    store = _FailingMarkFailedStore()
    manager = JobManager(store, tmp_path, [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    record = store.get_job(queued.id)
    assert record is not None
    record["status"] = "running"
    store.save_job(queued.id, record)
    assert queued.id in store.queue

    with pytest.raises(RuntimeError, match="injected persistence failure"):
        manager._recover()

    # Atomic contract: neither the record nor the queue changed.
    assert store.get_job(queued.id)["status"] == "running"
    assert queued.id in store.queue
    # No failed event was emitted (the transition never committed).
    assert all(event["type"] != "failed" for event in store.get_events(queued.id))

    # Restart recovery over the same persisted state reconciles cleanly.
    reconciled, working = _recover_with_working_store(record, tmp_path)
    assert reconciled.status(queued.id, owner_connection_id=OWNER).status == "failed"
    assert working.queue == {}
    assert working.claim_next() is None


def test_failed_transition_retries_and_heals_transient_store_failure(tmp_path, monkeypatch):
    """H1: a transient store failure on the failed transition is retried."""

    monkeypatch.setattr("backend.manager.FAILED_TRANSITION_BACKOFF_SECONDS", 0)
    store = _FlakyMarkFailedStore(failures_before_success=1)
    manager = JobManager(store, tmp_path, [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    record = store.get_job(queued.id)
    assert record is not None
    record["status"] = "running"
    store.save_job(queued.id, record)
    assert queued.id in store.queue

    manager._recover()

    recovered = manager.status(queued.id, owner_connection_id=OWNER)
    assert recovered.status == "failed"
    assert store.queue == {}
    assert store.claim_next() is None
    assert manager.events(queued.id, owner_connection_id=OWNER)[-1]["type"] == "failed"


def test_terminal_persistence_failure_keeps_recoverable_running_state(tmp_path, monkeypatch):
    """H1: a store failure after executor completion must not be masked.

    The job stays a tracked ``running`` job (active entry retained) with no
    partial failed transition, so stop()/restart can reconcile it.
    """

    monkeypatch.setattr("backend.manager.FAILED_TRANSITION_BACKOFF_SECONDS", 0)
    store = _FailingMarkFailedStore()
    manager = JobManager(store, tmp_path, [_PassiveExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    assert manager.run_once() is True
    assert manager.status(queued.id, owner_connection_id=OWNER).status == "running"
    assert queued.id in manager._active

    with pytest.raises(RuntimeError, match="injected persistence failure"):
        manager._finished(queued.id, 1, {"stdout": "x", "stderr": "y"})

    # No partial transition: still running, still tracked, no failed event.
    assert manager.status(queued.id, owner_connection_id=OWNER).status == "running"
    assert queued.id in manager._active
    assert all(event["type"] != "failed" for event in store.get_events(queued.id))

    # Restart recovery reconciles the same persisted record.
    record = store.get_job(queued.id)
    assert record is not None
    reconciled, working = _recover_with_working_store(record, tmp_path)
    assert reconciled.status(queued.id, owner_connection_id=OWNER).status == "failed"
    assert working.queue == {}
    assert reconciled.events(queued.id, owner_connection_id=OWNER)[-1]["type"] == "failed"


def test_manager_cancel_queued_job_emits_cancelled_event(tmp_path):
    """Queued and running cancellations must have the same observable transition."""

    manager = JobManager(InMemoryJobStore(), tmp_path, [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)

    cancelled = manager.cancel(queued.id, owner_connection_id=OWNER)

    assert cancelled.status == "cancelled"
    assert manager.events(queued.id, owner_connection_id=OWNER)[-1]["type"] == "cancelled"


def test_failed_job_keeps_complete_executor_logs(tmp_path):
    class FailingExecutor(ImmediateExecutor):
        name = "failing"

        def submit(self, job, artifact_dir, on_heartbeat, on_finished):
            stdout = Path(artifact_dir, "stdout.log")
            stderr = Path(artifact_dir, "stderr.log")
            stdout.write_text("started\n", encoding="utf-8")
            stderr.write_text("Traceback\nall details\n", encoding="utf-8")
            on_finished(1, {"stdout": str(stdout), "stderr": str(stderr)})
            return {"stdout": str(stdout), "stderr": str(stderr)}

    manager = JobManager(InMemoryJobStore(), tmp_path, [FailingExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    manager.run_once()

    failed = manager.status(queued.id, owner_connection_id=OWNER)
    assert failed.status == "failed"
    assert "all details" in (failed.error or "")
    assert manager.logs(queued.id, owner_connection_id=OWNER) == {
        "stdout": "started\n",
        "stderr": "Traceback\nall details\n",
    }


def test_slurm_script_maps_resources_without_client_commands(tmp_path):
    executor = SlurmExecutor(
        tmp_path,
        partition="gpu",
        account="project",
        capacity=ResourceRequest(cpu=32, memory_gb=128, gpu=2, gpu_type="A100"),
    )
    job = {
        "id": "job-123456789",
        "resources": ResourceRequest(
            cpu=8, memory_gb=32, gpu=1, gpu_type="A100", node="node-01"
        ).model_dump(mode="json"),
    }

    script = executor.build_batch_script(job, str(tmp_path / "job"))

    assert "#SBATCH --cpus-per-task=8" in script
    assert "#SBATCH --mem=32G" in script
    assert "#SBATCH --gres=gpu:A100:1" in script
    assert "#SBATCH --nodelist=node-01" in script
    assert "#SBATCH --output=" in script and "stdout.log" in script
    assert "src/main.py" in script
    assert "network" not in script


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("gpu_type", "A100\nid > /tmp/owned"),
        ("node", "node-01\nid > /tmp/owned"),
    ],
)
def test_resource_request_rejects_unsafe_slurm_selectors(field, value):
    """Resource selectors must not inject a second line into a batch script."""

    with pytest.raises(ValueError, match="selector"):
        ResourceRequest(**{field: value})


def test_api_requires_pairing_and_scopes_jobs_to_their_connection(tmp_path):
    manager = JobManager(InMemoryJobStore(), tmp_path, [ImmediateExecutor()])
    auth = AuthService(InMemoryAuthStore())
    first = auth.create_pairing("First", client_host="127.0.0.1")
    second = auth.create_pairing("Second", client_host="127.0.0.2")
    auth.approve(first.request_id)
    auth.approve(second.request_id)
    app = create_app(manager, auth_service=auth, admin_token="admin-secret")

    async def exercise_api() -> None:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                assert (await client.get("/health")).json() == {"status": "ok"}
                assert (await client.get("/datasets")).status_code == 401
                first_headers = {"authorization": f"Bearer {first.token}"}
                second_headers = {"authorization": f"Bearer {second.token}"}
                datasets = await client.get("/datasets", headers=first_headers)
                assert datasets.status_code == 200
                assert any(item["name"] == "MNISTDataset" for item in datasets.json())
                response = await client.post(
                    "/jobs",
                    headers=first_headers,
                    json=submission().model_dump(mode="json"),
                )
                assert response.status_code == 202
                assert response.json()["status"] == "queued"
                job_id = response.json()["id"]
                assert len((await client.get("/jobs", headers=first_headers)).json()) == 1
                assert (await client.get("/jobs", headers=second_headers)).json() == []
                assert (await client.get(f"/jobs/{job_id}", headers=second_headers)).status_code == 404
                tail = await client.get(
                    f"/jobs/{job_id}/logs/tail?stdout_after=0&stderr_after=0",
                    headers=first_headers,
                )
                assert tail.status_code == 200
                assert set(tail.json()["stdout"]) == {"text", "offset", "reset"}
                assert (await client.get(f"/jobs/{job_id}/logs/tail", headers=second_headers)).status_code == 404

    asyncio.run(exercise_api())


def _materialize_package(
    store: InMemoryJobStore,
    job: JobStatus,
    *,
    wheel_bytes: bytes = b"wheel-content",
    wheel_rel: str = "dist/nnm-model.whl",
    sha256: str | None = None,
) -> dict[str, Any]:
    """Write a wheel and a matching manifest into a job's artifact directory."""
    record = store.get_job(job.id)
    assert record is not None
    artifact = Path(record["artifact_dir"])
    wheel = artifact / wheel_rel
    wheel.parent.mkdir(parents=True, exist_ok=True)
    wheel.write_bytes(wheel_bytes)
    record["model_package"] = {
        "schema_version": 1,
        "package_name": "nnm-model",
        "version": "0.1.0",
        "wheel": wheel_rel,
        "sha256": sha256 if sha256 is not None else hashlib.sha256(wheel_bytes).hexdigest(),
        "input_adapter": {"kind": "tensor", "version": 1},
    }
    store.save_job(job.id, record)
    return record


def _download_context(
    tmp_path: Path,
) -> tuple[Any, InMemoryJobStore, JobStatus, PairingGrant, PairingGrant]:
    """Build an authenticated app with one owner, one other, and a packaged job."""
    store = InMemoryJobStore()
    manager = JobManager(
        store,
        tmp_path,
        [ImmediateExecutor()],
        package_snapshot_dir=tmp_path / "snapshots",
    )
    auth = AuthService(InMemoryAuthStore())
    owner = auth.create_pairing("Owner", client_host="127.0.0.1")
    other = auth.create_pairing("Other", client_host="127.0.0.2")
    auth.approve(owner.request_id)
    auth.approve(other.request_id)
    job = manager.submit(submission(), owner_connection_id=owner.connection_id)
    app = create_app(manager, auth_service=auth, admin_token="admin-secret")
    return app, store, job, owner, other


def test_api_downloads_only_the_owner_model_wheel(tmp_path):
    app, store, job, owner, other = _download_context(tmp_path)
    _materialize_package(store, job)
    expected = hashlib.sha256(b"wheel-content").hexdigest()

    async def exercise_api() -> None:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                owner_headers = {"authorization": f"Bearer {owner.token}"}
                other_headers = {"authorization": f"Bearer {other.token}"}
                response = await client.get(f"/jobs/{job.id}/package", headers=owner_headers)
                assert response.status_code == 200
                assert response.content == b"wheel-content"
                assert response.headers["x-nnm-sha256"] == expected
                assert "attachment" in response.headers["content-disposition"]
                assert (await client.get(f"/jobs/{job.id}/package", headers=other_headers)).status_code == 404

    asyncio.run(exercise_api())


def test_api_rejects_a_wheel_replaced_after_export(tmp_path):
    """D3: bytes that no longer match the manifest digest are never served."""
    app, store, job, owner, _other = _download_context(tmp_path)
    _materialize_package(store, job, wheel_bytes=b"original")
    record = store.get_job(job.id)
    assert record is not None
    wheel = Path(record["artifact_dir"]) / record["model_package"]["wheel"]
    wheel.write_bytes(b"tampered-bytes")

    async def exercise_api() -> None:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                headers = {"authorization": f"Bearer {owner.token}"}
                response = await client.get(f"/jobs/{job.id}/package", headers=headers)
                assert response.status_code == 409
                assert response.json()["detail"] == {
                    "code": "package_integrity_error",
                    "message": "Model package integrity check failed",
                }
                # A conflicted download must not leak where artifacts live.
                assert str(tmp_path) not in response.text

    asyncio.run(exercise_api())


def test_api_rejects_a_missing_declared_digest(tmp_path):
    """A manifest without a sha256 cannot be verified, so nothing is served."""
    app, store, job, owner, _other = _download_context(tmp_path)
    _materialize_package(store, job)
    record = store.get_job(job.id)
    assert record is not None
    del record["model_package"]["sha256"]
    store.save_job(job.id, record)

    async def exercise_api() -> None:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                headers = {"authorization": f"Bearer {owner.token}"}
                response = await client.get(f"/jobs/{job.id}/package", headers=headers)
                assert response.status_code == 409
                assert response.json()["detail"] == {
                    "code": "package_integrity_error",
                    "message": "Model package integrity cannot be verified",
                }
                assert str(tmp_path) not in response.text

    asyncio.run(exercise_api())


def test_api_rejects_a_malformed_declared_digest(tmp_path):
    """A non-hex manifest digest is corrupt state, not a downloadable package."""
    app, store, job, owner, _other = _download_context(tmp_path)
    _materialize_package(store, job, sha256="not-a-hex-digest")

    async def exercise_api() -> None:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                headers = {"authorization": f"Bearer {owner.token}"}
                response = await client.get(f"/jobs/{job.id}/package", headers=headers)
                assert response.status_code == 409
                assert response.json()["detail"]["code"] == "package_integrity_error"
                assert str(tmp_path) not in response.text

    asyncio.run(exercise_api())


def test_api_exposes_the_package_digest_header_via_cors(tmp_path):
    """Browsers must be allowed to read X-NNM-SHA256 on the download response."""
    app, store, job, owner, _other = _download_context(tmp_path)
    _materialize_package(store, job)

    async def exercise_api() -> None:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                headers = {
                    "authorization": f"Bearer {owner.token}",
                    "origin": "http://127.0.0.1:5173",
                }
                response = await client.get(f"/jobs/{job.id}/package", headers=headers)
                assert response.status_code == 200
                assert response.headers["x-nnm-sha256"] == hashlib.sha256(b"wheel-content").hexdigest()
                assert "X-NNM-SHA256" in response.headers.get("access-control-expose-headers", "")

    asyncio.run(exercise_api())


def test_api_pins_served_bytes_to_the_verified_snapshot(tmp_path):
    """D3 TOCTOU: replacing the original wheel after verification but before
    the response body is read must not change the bytes that are served.

    The manager copies and hashes the wheel from one opened source handle into
    an immutable private snapshot; the endpoint serves only that snapshot and
    never reopens the mutable artifact path. The custom ASGI ``send`` replaces
    the original wheel at ``http.response.start`` — after the snapshot was
    verified, before any body byte was read — so a regression that reopened
    the artifact path would serve the replaced bytes and fail this test.
    """
    app, store, job, owner, _other = _download_context(tmp_path)
    original = b"original-wheel-bytes"
    _materialize_package(store, job, wheel_bytes=original)
    record = store.get_job(job.id)
    assert record is not None
    wheel = Path(record["artifact_dir"]) / record["model_package"]["wheel"]
    manager = app.state.manager
    snapshot_dir = manager.package_snapshot_dir
    assert snapshot_dir is not None

    async def exercise_api() -> None:
        status_code = 0
        response_headers: dict[str, str] = {}
        body_parts: list[bytes] = []

        async def send(message: dict[str, Any]) -> None:
            nonlocal status_code, response_headers
            if message["type"] == "http.response.start":
                status_code = message["status"]
                response_headers = {
                    key.decode(): value.decode() for key, value in message["headers"]
                }
                # Verification and snapshot creation already finished; replace
                # the original artifact before the response body is produced.
                wheel.write_bytes(b"replaced-after-verification")
            elif message["type"] == "http.response.body":
                body_parts.append(message["body"])

        async def receive() -> dict[str, Any]:
            return {"type": "http.disconnect"}

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "headers": [(b"authorization", f"Bearer {owner.token}".encode())],
            "scheme": "http",
            "path": f"/jobs/{job.id}/package",
            "raw_path": f"/jobs/{job.id}/package".encode(),
            "query_string": b"",
            "server": ("test", 80),
            "client": ("127.0.0.1", 1234),
            "root_path": "",
        }
        await app(scope, receive, send)

        served = b"".join(body_parts)
        assert status_code == 200
        assert response_headers["x-nnm-sha256"] == hashlib.sha256(original).hexdigest()
        assert wheel.read_bytes() == b"replaced-after-verification"
        assert served == original
        assert served != wheel.read_bytes()
        # The verified snapshot is removed after the response completed.
        assert list(snapshot_dir.iterdir()) == []

    asyncio.run(exercise_api())


def test_api_removes_snapshot_when_send_fails_during_body_streaming(tmp_path):
    """D3 cleanup: a mid-stream failure must not leak the verified snapshot.

    Starlette invokes a FileResponse ``background`` callback only after a
    fully successful transfer, so a plain FileResponse would skip cleanup when
    the client connection drops and ``send`` raises while the body is being
    streamed. The endpoint wraps the response so the private snapshot is
    removed on every outcome. This test drives the real ASGI app with a
    ``send`` that raises exactly after ``http.response.start`` — verification
    and snapshot creation already finished, but the transfer did not — and
    asserts both the propagated exception and the cleanup.
    """
    app, store, job, owner, _other = _download_context(tmp_path)
    original = b"original-wheel-bytes"
    _materialize_package(store, job, wheel_bytes=original)
    manager = app.state.manager
    snapshot_dir = manager.package_snapshot_dir
    assert snapshot_dir is not None

    class StreamInterrupted(Exception):
        """Sentinel for the connection loss a server raises from ``send``."""

    snapshot_modes: list[int] = []

    async def exercise_api() -> None:
        async def send(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                # The verified snapshot exists while the response is served;
                # record its private permissions for the 0600 check.
                snapshots = list(snapshot_dir.iterdir())
                assert len(snapshots) == 1
                snapshot_modes.append(snapshots[0].stat().st_mode)
            elif message["type"] == "http.response.body":
                raise StreamInterrupted("connection lost while streaming body")

        async def receive() -> dict[str, Any]:
            return {"type": "http.disconnect"}

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "headers": [(b"authorization", f"Bearer {owner.token}".encode())],
            "scheme": "http",
            "path": f"/jobs/{job.id}/package",
            "raw_path": f"/jobs/{job.id}/package".encode(),
            "query_string": b"",
            "server": ("test", 80),
            "client": ("127.0.0.1", 1234),
            "root_path": "",
        }
        with pytest.raises(StreamInterrupted, match="connection lost"):
            await app(scope, receive, send)

        # The verified private snapshot is gone even though the transfer failed.
        assert list(snapshot_dir.iterdir()) == []

    asyncio.run(exercise_api())
    if os.name == "posix":
        assert len(snapshot_modes) == 1
        assert stat.S_IMODE(snapshot_modes[0]) == 0o600


def test_api_removes_snapshot_when_download_task_is_cancelled(tmp_path):
    """D3 cleanup: cancelling the streaming task must also remove the snapshot.

    Uvicorn cancels the request task when the client transport goes away or
    during shutdown; the cancellation lands at an await inside the response.
    The cleanup wrapper still runs its ``finally`` before the CancelledError
    escapes, so a cancelled download never leaves the private snapshot behind.
    The test blocks ``send`` on the first body message so the cancellation
    deterministically lands mid-stream, after the verified snapshot exists.
    """
    app, store, job, owner, _other = _download_context(tmp_path)
    _materialize_package(store, job, wheel_bytes=b"wheel-content")
    manager = app.state.manager
    snapshot_dir = manager.package_snapshot_dir
    assert snapshot_dir is not None

    async def exercise_api() -> None:
        response_started = asyncio.Event()
        hold_body = asyncio.Event()

        async def send(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                response_started.set()
            elif message["type"] == "http.response.body":
                await hold_body.wait()

        async def receive() -> dict[str, Any]:
            return {"type": "http.disconnect"}

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "headers": [(b"authorization", f"Bearer {owner.token}".encode())],
            "scheme": "http",
            "path": f"/jobs/{job.id}/package",
            "raw_path": f"/jobs/{job.id}/package".encode(),
            "query_string": b"",
            "server": ("test", 80),
            "client": ("127.0.0.1", 1234),
            "root_path": "",
        }
        task = asyncio.create_task(app(scope, receive, send))
        await response_started.wait()
        # The response is now streaming the verified private snapshot.
        assert list(snapshot_dir.iterdir())
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        # The verified private snapshot is removed after the cancelled transfer.
        assert list(snapshot_dir.iterdir()) == []

    asyncio.run(exercise_api())


def test_api_snapshot_mismatch_returns_409_without_body_and_cleans_up(tmp_path):
    """A wheel whose snapshot digest differs from the manifest is rejected with
    409, no wheel bytes are served, and the temporary snapshot is deleted."""
    app, store, job, owner, _other = _download_context(tmp_path)
    _materialize_package(store, job, wheel_bytes=b"original")
    record = store.get_job(job.id)
    assert record is not None
    wheel = Path(record["artifact_dir"]) / record["model_package"]["wheel"]
    wheel.write_bytes(b"tampered-before-download")
    manager = app.state.manager
    snapshot_dir = manager.package_snapshot_dir
    assert snapshot_dir is not None

    async def exercise_api() -> None:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                headers = {"authorization": f"Bearer {owner.token}"}
                response = await client.get(f"/jobs/{job.id}/package", headers=headers)
                assert response.status_code == 409
                assert response.json()["detail"] == {
                    "code": "package_integrity_error",
                    "message": "Model package integrity check failed",
                }
                # Only the error detail is sent; no wheel bytes, no paths.
                assert b"tampered-before-download" not in response.content
                assert str(tmp_path) not in response.text

    asyncio.run(exercise_api())
    assert list(snapshot_dir.iterdir()) == []


def test_public_pairing_flow_waits_for_administrator_approval(tmp_path):
    manager = JobManager(InMemoryJobStore(), tmp_path, [ImmediateExecutor()])
    auth = AuthService(InMemoryAuthStore())
    app = create_app(manager, auth_service=auth, admin_token="admin-secret")

    async def exercise_api() -> None:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                created = await client.post("/pairing/requests", json={"device_name": "Lab browser"})
                assert created.status_code == 201
                body = created.json()
                headers = {"authorization": f"Bearer {body['token']}"}
                pending = await client.get(f"/pairing/requests/{body['request_id']}", headers=headers)
                assert pending.json()["status"] == "pending"
                assert (await client.get("/session", headers=headers)).status_code == 401

                auth.approve(body["request_id"])

                assert (await client.get("/session", headers=headers)).status_code == 200

    asyncio.run(exercise_api())


def test_admin_api_approves_sessions_and_manages_all_jobs(tmp_path):
    store = InMemoryJobStore()
    manager = JobManager(store, tmp_path, [ImmediateExecutor()])
    auth = AuthService(InMemoryAuthStore())
    pairing = auth.create_pairing("Admin test", client_host="127.0.0.1")
    app = create_app(manager, auth_service=auth, admin_token="admin-secret")

    async def exercise_api() -> None:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                assert (await client.get("/admin/pairing/requests")).status_code == 401
                wrong = {"x-nnm-admin-token": "wrong"}
                assert (await client.get("/admin/pairing/requests", headers=wrong)).status_code == 401
                admin = {"x-nnm-admin-token": "admin-secret"}
                pending = await client.get("/admin/pairing/requests", headers=admin)
                assert [item["id"] for item in pending.json()] == [pairing.request_id]

                approved = await client.post(
                    f"/admin/pairing/requests/{pairing.request_id}/approve",
                    headers=admin,
                    json={"ttl": "8h"},
                )
                assert approved.status_code == 200
                assert approved.json()["status"] == "active"
                session_headers = {"authorization": f"Bearer {pairing.token}"}
                submitted = await client.post(
                    "/jobs",
                    headers=session_headers,
                    json=submission().model_dump(mode="json"),
                )
                assert submitted.status_code == 202
                job_id = submitted.json()["id"]
                assert any(item["id"] == job_id for item in (await client.get("/admin/jobs", headers=admin)).json())
                assert (await client.delete(f"/admin/jobs/{job_id}", headers=admin)).status_code == 200

                sessions = await client.get("/admin/sessions", headers=admin)
                assert sessions.json()[0]["id"] == pairing.connection_id
                assert "token_hash" not in sessions.text
                revoked = await client.delete(
                    f"/admin/sessions/{pairing.connection_id}",
                    headers=admin,
                )
                assert revoked.json()["status"] == "revoked"
                assert (await client.get("/jobs", headers=session_headers)).status_code == 401

    asyncio.run(exercise_api())


def test_job_submission_rejects_missing_dataset():
    with pytest.raises(ValueError, match="training.dataset"):
        normalize_training_config({"trainer": {"max_epochs": 1}})


# ---------------------------------------------------------------------------
# Project-aware training execution (S2)
# ---------------------------------------------------------------------------


class FakeProjectResolver:
    """Stand-in for the S1 ProjectManager consumed by the job manager."""

    def __init__(
        self,
        root: str | Path,
        *,
        environment_status: str = "ready",
        wandb: WandbSettings | None = None,
        api_key: str | None = "project-secret-api-key",
        registered: bool = True,
    ) -> None:
        self.root = Path(root)
        self.environment_status = environment_status
        self.wandb = wandb or WandbSettings()
        self.api_key = api_key
        self.registered = registered

    def get_project(self, project_id: str) -> ProjectSummary:
        self._require(project_id)
        return ProjectSummary(
            id=project_id,
            name="proj",
            root=str(self.root),
            model="model/graph.json",
            environment=EnvironmentState(
                status=self.environment_status,  # type: ignore[arg-type]
                python=str(project_python(self.root)),
            ),
            wandb=self.wandb,
            last_opened="2026-01-01T00:00:00+00:00",
        )

    def resolve_root(self, project_id: str) -> Path:
        self._require(project_id)
        return self.root

    def wandb_api_key(self, project_id: str) -> str | None:
        self._require(project_id)
        return self.api_key

    def _require(self, project_id: str) -> None:
        if not self.registered:
            raise ProjectError("unknown_project", f"unknown project {project_id}")


def project_submission(project_id: str, *, wandb: dict[str, Any] | None = None) -> JobSubmission:
    """Build a legacy submission carrying an optional project id and wandb doc."""
    base = submission()
    training = json.loads(json.dumps(base.training))
    if wandb is not None:
        training["wandb"] = wandb
    return base.model_copy(update={"project_id": project_id, "training": training})


def project_submission_without_wandb(project_id: str) -> JobSubmission:
    """Build a project submission that leaves every W&B field to the project."""
    base = submission()
    training = json.loads(json.dumps(base.training))
    training.pop("wandb", None)
    return base.model_copy(update={"project_id": project_id, "training": training})


def _project_manager(
    tmp_path: Path,
    resolver: FakeProjectResolver,
    *,
    executors: list[Any] | None = None,
) -> JobManager:
    return JobManager(
        InMemoryJobStore(),
        tmp_path / "jobs",
        executors or [ImmediateExecutor()],
        project_manager=resolver,
    )


def test_project_job_with_unknown_project_id_fails_before_creating_artifacts(tmp_path):
    manager = _project_manager(tmp_path, FakeProjectResolver(tmp_path / "proj", registered=False))

    with pytest.raises(ValueError, match="unknown project"):
        manager.submit(project_submission("does-not-exist"), owner_connection_id=OWNER)

    # An unresolved project must never create an artifact or queue a record.
    assert list(manager.artifact_root.iterdir()) == []
    assert manager.store.list_jobs() == []
    assert manager.store.claim_next() is None


def test_project_job_stores_artifacts_under_project_runs_dir(tmp_path, packaged_export):
    resolver = FakeProjectResolver(tmp_path / "proj")
    manager = _project_manager(tmp_path, resolver)
    queued = manager.submit(project_submission("proj-id"), owner_connection_id=OWNER)

    assert queued.status == "queued"
    artifact = Path(queued.artifact_dir)
    assert artifact.parent == (resolver.root / "runs").resolve()
    assert artifact.name == queued.id
    assert (artifact / "requested_config.json").is_file()
    assert (artifact / "cfg" / "base.yaml").is_file()
    # The legacy artifact root is never used for a project-scoped job.
    assert not (manager.artifact_root / queued.id).exists()


def test_project_job_merges_wandb_defaults_under_explicit_job_settings(tmp_path, packaged_export):
    settings = WandbSettings(
        entity="team",
        project="proj-runs",
        tags=["proj"],
        run_name_template="proj-run",
        mode="online",
    )
    manager = _project_manager(tmp_path, FakeProjectResolver(tmp_path / "proj", wandb=settings))
    queued = manager.submit(
        project_submission("proj-id", wandb={"project": "tests", "mode": "disabled"}),
        owner_connection_id=OWNER,
    )

    record = manager.store.get_job(queued.id)
    assert record is not None
    merged = record["submission"]["training"]["wandb"]
    # Explicit job fields win; omitted project fields inherit.
    assert merged["project"] == "tests"
    assert merged["mode"] == "disabled"
    assert merged["entity"] == "team"
    assert merged["tags"] == ["proj"]
    assert merged["name"] == "proj-run"
    # The raw client request is preserved verbatim in requested_config.json.
    requested = json.loads((Path(queued.artifact_dir) / "requested_config.json").read_text(encoding="utf-8"))
    assert requested["training"]["wandb"] == {"project": "tests", "mode": "disabled"}
    # The merged settings drive the generated Hydra wandb config.
    wandb_yaml = (Path(queued.artifact_dir) / "cfg" / "wandb" / "wandb.yaml").read_text(encoding="utf-8")
    assert "project: tests" in wandb_yaml
    assert "entity: team" in wandb_yaml
    assert "mode: disabled" in wandb_yaml


def test_project_job_omitted_wandb_fields_inherit_project_defaults(tmp_path, packaged_export):
    settings = WandbSettings(entity="team", tags=["a", "b"], run_name_template="proj-run")
    manager = _project_manager(tmp_path, FakeProjectResolver(tmp_path / "proj", wandb=settings))
    queued = manager.submit(project_submission_without_wandb("proj-id"), owner_connection_id=OWNER)

    record = manager.store.get_job(queued.id)
    assert record is not None
    merged = record["submission"]["training"]["wandb"]
    assert merged == {
        "project": "NeuralNetworks",
        "mode": "online",
        "entity": "team",
        "tags": ["a", "b"],
        "name": "proj-run",
    }


class CapturingExecutor(ImmediateExecutor):
    """Immediate executor that records the project context handed to it."""

    def __init__(self) -> None:
        super().__init__()
        self.project_contexts: list[dict[str, Any] | None] = []

    def submit(self, job, artifact_dir, on_heartbeat, on_finished, project=None):
        self.project_contexts.append(project)
        return super().submit(job, artifact_dir, on_heartbeat, on_finished)


def test_project_job_injects_api_key_only_into_the_child_environment(tmp_path, packaged_export):
    resolver = FakeProjectResolver(tmp_path / "proj", api_key="super-secret-key")
    executor = CapturingExecutor()
    manager = JobManager(InMemoryJobStore(), tmp_path / "jobs", [executor], project_manager=resolver)
    parent_key_before = os.environ.get("WANDB_API_KEY")
    queued = manager.submit(project_submission("proj-id"), owner_connection_id=OWNER)
    Path(queued.artifact_dir, "weights.safetensors").write_bytes(b"safe-weights")

    assert manager.run_once() is True

    project_ctx = executor.project_contexts[-1]
    assert project_ctx is not None
    # The key exists only inside the child environment snapshot.
    assert project_ctx["env"]["WANDB_API_KEY"] == "super-secret-key"
    assert os.environ.get("WANDB_API_KEY") == parent_key_before
    # PYTHONPATH exposes project src/ and datasets/ ahead of any inherited path.
    pythonpath = project_ctx["env"]["PYTHONPATH"].split(os.pathsep)
    assert pythonpath[0] == str((resolver.root / "src").resolve())
    assert pythonpath[1] == str((resolver.root / "datasets").resolve())

    # The key never lands in the persisted record, configs, or log files.
    record = manager.store.get_job(queued.id)
    assert record is not None
    assert "super-secret-key" not in json.dumps(record)
    for path in Path(queued.artifact_dir).rglob("*"):
        if path.is_file():
            content = path.read_text(encoding="utf-8", errors="replace")
            assert "super-secret-key" not in content, f"secret leaked into {path}"


def test_project_job_with_missing_environment_fails_clearly(tmp_path):
    manager = _project_manager(
        tmp_path,
        FakeProjectResolver(tmp_path / "proj", environment_status="missing"),
    )

    with pytest.raises(ValueError, match="environment is missing"):
        manager.submit(project_submission("proj-id"), owner_connection_id=OWNER)
    assert manager.store.list_jobs() == []


def test_project_job_requires_a_local_executor(tmp_path):
    class SlurmLikeExecutor(ImmediateExecutor):
        kind = "slurm"
        name = "slurm-fake"

    manager = JobManager(
        InMemoryJobStore(),
        tmp_path / "jobs",
        [SlurmLikeExecutor()],
        project_manager=FakeProjectResolver(tmp_path / "proj"),
    )

    with pytest.raises(ValueError, match="local executor"):
        manager.submit(project_submission("proj-id"), owner_connection_id=OWNER)
    assert manager.store.list_jobs() == []
    assert list(manager.artifact_root.iterdir()) == []


def test_project_job_is_never_routed_to_a_slurm_executor(tmp_path, packaged_export):
    class SlurmLikeExecutor(ImmediateExecutor):
        kind = "slurm"
        name = "slurm-fake"

    manager = JobManager(
        InMemoryJobStore(),
        tmp_path / "jobs",
        [SlurmLikeExecutor(), ImmediateExecutor()],
        project_manager=FakeProjectResolver(tmp_path / "proj"),
    )
    queued = manager.submit(project_submission("proj-id"), owner_connection_id=OWNER)
    Path(queued.artifact_dir, "weights.safetensors").write_bytes(b"safe-weights")

    assert manager.run_once() is True
    finished = manager.status(queued.id, owner_connection_id=OWNER)
    assert finished.status == "succeeded"
    assert finished.executor == "local"


def test_project_runs_dir_cannot_escape_the_project_root_via_symlink(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "runs").symlink_to(outside, target_is_directory=True)
    manager = _project_manager(tmp_path, FakeProjectResolver(root))

    with pytest.raises(ValueError, match="outside the project root"):
        manager.submit(project_submission("proj-id"), owner_connection_id=OWNER)
    # The symlink target must not receive any artifacts.
    assert list(outside.iterdir()) == []
    assert manager.store.list_jobs() == []


def test_legacy_job_without_project_id_keeps_the_artifact_root_layout(tmp_path, packaged_export):
    manager = JobManager(InMemoryJobStore(), tmp_path / "jobs", [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)

    assert Path(queued.artifact_dir) == manager.artifact_root / queued.id
    requested = json.loads((Path(queued.artifact_dir) / "requested_config.json").read_text(encoding="utf-8"))
    assert requested == submission().model_dump(mode="json")


def test_project_job_builds_hydra_configs_for_project_dataset_targets(tmp_path, packaged_export):
    root = tmp_path / "proj"
    datasets_dir = root / "datasets"
    datasets_dir.mkdir(parents=True)
    (datasets_dir / "my_ds.py").write_text(
        "from dataset.ds import Dataset\n"
        "class MyDS(Dataset):\n"
        "    @classmethod\n"
        "    def num_classes(cls, config):\n"
        "        return 7\n"
        "    def division(self):\n"
        "        raise NotImplementedError\n",
        encoding="utf-8",
    )
    manager = _project_manager(tmp_path, FakeProjectResolver(root))
    base = project_submission("proj-id")
    training = json.loads(json.dumps(base.training))
    training["dataset"] = {"_target_": "my_ds.MyDS", "batch_size": 8}
    queued = manager.submit(base.model_copy(update={"training": training}), owner_connection_id=OWNER)

    net = (Path(queued.artifact_dir) / "cfg" / "net" / "custom_sequence.yaml").read_text(encoding="utf-8")
    assert "num_classes: 7" in net


def test_build_job_hydra_configs_imports_project_datasets_without_leaking_state(tmp_path):
    root = tmp_path / "proj"
    datasets_dir = root / "datasets"
    datasets_dir.mkdir(parents=True)
    (datasets_dir / "my_ds.py").write_text(
        "from dataset.ds import Dataset\n"
        "class MyDS(Dataset):\n"
        "    @classmethod\n"
        "    def num_classes(cls, config):\n"
        "        return 7\n"
        "    def division(self):\n"
        "        raise NotImplementedError\n",
        encoding="utf-8",
    )
    job = submission().model_dump(mode="json")
    job["training"]["dataset"] = {"_target_": "my_ds.MyDS", "batch_size": 8}
    path_before = list(sys.path)

    config_dir = build_job_hydra_configs(job, tmp_path / "out", import_roots=(datasets_dir,))

    net = (config_dir / "net" / "custom_sequence.yaml").read_text(encoding="utf-8")
    assert "num_classes: 7" in net
    # Project modules never leak into global interpreter state.
    assert "my_ds" not in sys.modules
    assert str(datasets_dir) not in sys.path
    assert sys.path == path_before


def test_build_job_hydra_configs_import_roots_do_not_cross_contaminate_projects(tmp_path):
    """Two projects sharing a module name must each resolve their own file."""
    first = tmp_path / "one" / "datasets"
    second = tmp_path / "two" / "datasets"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    for datasets_dir, count in ((first, 3), (second, 9)):
        (datasets_dir / "my_ds.py").write_text(
            "from dataset.ds import Dataset\n"
            f"class MyDS(Dataset):\n"
            f"    @classmethod\n"
            f"    def num_classes(cls, config):\n"
            f"        return {count}\n"
            "    def division(self):\n"
            "        raise NotImplementedError\n",
            encoding="utf-8",
        )
    job = submission().model_dump(mode="json")
    job["training"]["dataset"] = {"_target_": "my_ds.MyDS", "batch_size": 8}

    first_cfg = build_job_hydra_configs(job, tmp_path / "out-a", import_roots=(first,))
    second_cfg = build_job_hydra_configs(job, tmp_path / "out-b", import_roots=(second,))

    assert "num_classes: 3" in (first_cfg / "net" / "custom_sequence.yaml").read_text(encoding="utf-8")
    assert "num_classes: 9" in (second_cfg / "net" / "custom_sequence.yaml").read_text(encoding="utf-8")
    assert "my_ds" not in sys.modules
    assert str(first) not in sys.path
    assert str(second) not in sys.path


def test_local_executor_command_uses_sys_executable_without_project_context(tmp_path):
    executor = LocalExecutor(tmp_path)
    command = executor._command({"id": "j1"}, tmp_path / "artifact")
    assert command[0] == sys.executable


def test_local_executor_command_uses_the_project_interpreter_with_project_context(tmp_path):
    executor = LocalExecutor(tmp_path)
    project = {"python": "/proj/.venv/bin/python", "env": {}, "root": "/proj", "project_id": "p"}
    command = executor._command({"id": "j1"}, tmp_path / "artifact", project)
    assert command[0] == "/proj/.venv/bin/python"
    assert str(tmp_path / "artifact" / "cfg") in command


class _FakeProcess:
    """Process double whose poll reports completion immediately."""

    def __init__(self, returncode: int = 1) -> None:
        self.pid = 4242
        self.returncode = returncode

    def poll(self) -> int:
        return self.returncode


def _capture_popen(monkeypatch, captured: dict[str, Any]) -> None:
    monkeypatch.setattr(
        "backend.executors.local.subprocess.Popen",
        lambda command, **kwargs: captured.update(command=command, kwargs=kwargs) or _FakeProcess(),
    )


def test_local_executor_forwards_the_project_environment_to_the_child(tmp_path, monkeypatch):
    captured: dict[str, Any] = {}
    _capture_popen(monkeypatch, captured)
    executor = LocalExecutor(tmp_path)
    project = {
        "python": "/proj/.venv/bin/python",
        "env": {"WANDB_API_KEY": "secret", "PYTHONPATH": "/proj/src:/proj/datasets"},
    }
    artifact = tmp_path / "artifact"

    executor.submit({"id": "j1"}, str(artifact), lambda details: None, lambda rc, details: None, project=project)

    assert captured["kwargs"]["env"] == project["env"]
    assert captured["command"][0] == "/proj/.venv/bin/python"


def test_local_executor_legacy_jobs_inherit_the_parent_environment(tmp_path, monkeypatch):
    captured: dict[str, Any] = {}
    _capture_popen(monkeypatch, captured)
    executor = LocalExecutor(tmp_path)
    artifact = tmp_path / "artifact"

    executor.submit({"id": "j2"}, str(artifact), lambda details: None, lambda rc, details: None)

    assert captured["kwargs"].get("env") is None
    assert captured["command"][0] == sys.executable


def test_api_rejects_project_jobs_with_unknown_project_before_writing_artifacts(tmp_path):
    manager = _project_manager(tmp_path, FakeProjectResolver(tmp_path / "proj", registered=False))
    auth = AuthService(InMemoryAuthStore())
    pairing = auth.create_pairing("Browser", client_host="127.0.0.1")
    auth.approve(pairing.request_id)
    app = create_app(manager, auth_service=auth, admin_token="admin-secret")

    async def exercise_api() -> None:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                headers = {"authorization": f"Bearer {pairing.token}"}
                payload = project_submission("unknown-id").model_dump(mode="json")
                response = await client.post("/jobs", headers=headers, json=payload)
                assert response.status_code == 422
                assert "project" in response.json()["detail"].lower()
                assert list(manager.artifact_root.iterdir()) == []

    asyncio.run(exercise_api())
