"""Tests for remote job configuration, storage, scheduling and API wiring."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from backend.app import create_app
from backend.auth import AuthService, InMemoryAuthStore
from backend.config_service import build_job_hydra_configs, normalize_training_config
from backend.dataset_registry import discover_datasets
from backend.executors import SlurmExecutor
from backend.executors.local import LocalExecutor
from backend.manager import JobManager
from backend.models import JobSubmission, ResourceRequest
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

    def submit(self, job, artifact_dir, on_heartbeat, on_finished):
        Path(artifact_dir, "stdout.log").write_text("ok\n", encoding="utf-8")
        Path(artifact_dir, "stderr.log").write_text("", encoding="utf-8")
        on_heartbeat({"worker": "test"})
        on_finished(0, {"stdout": str(Path(artifact_dir, "stdout.log"))})
        return {"worker": "test"}

    def cancel(self, job_id: str) -> bool:
        return True


def test_normalize_training_config_accepts_dataset_target_string():
    normalized = normalize_training_config({"dataset": "dataset.mnist.MNISTDataset"})
    assert normalized["dataset"] == {"_target_": "dataset.mnist.MNISTDataset"}


def test_local_executor_progress_override_supports_existing_trainer_key(tmp_path):
    command = LocalExecutor(tmp_path)._command({}, tmp_path)

    assert "++trainer.enable_progress_bar=false" in command


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


def test_manager_builds_job_artifacts_and_finishes(tmp_path):
    manager = JobManager(InMemoryJobStore(), tmp_path, [ImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)
    assert queued.status == "queued"
    assert manager.run_once() is True
    finished = manager.status(queued.id, owner_connection_id=OWNER)
    assert finished.status == "succeeded"
    assert Path(finished.artifact_dir, "requested_config.json").exists()
    assert Path(finished.artifact_dir, "resolved_config.yaml").exists()
    resolved = Path(finished.artifact_dir, "resolved_config.yaml").read_text(encoding="utf-8")
    assert "max_epochs: 2" in resolved
    assert "dataset.enron_spam.EnronSpamDataset" in resolved
    assert manager.logs(queued.id, owner_connection_id=OWNER)["stdout"] == "ok\n"


def test_manager_exports_a_model_wheel_after_a_successful_job(tmp_path, monkeypatch):
    def fake_export(artifact_dir, *, package_name, version):
        wheel = Path(artifact_dir) / "dist" / "model.whl"
        wheel.parent.mkdir()
        wheel.write_bytes(b"wheel")
        (Path(artifact_dir) / "model-package.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "package_name": package_name,
                    "version": version,
                    "wheel": "dist/model.whl",
                    "sha256": "checksum",
                    "input_adapter": {"kind": "tensor", "version": 1},
                }
            ),
            encoding="utf-8",
        )
        return wheel

    monkeypatch.setattr("backend.manager.build_model_wheel", fake_export)
    manager = JobManager(InMemoryJobStore(), tmp_path, [ImmediateExecutor()])
    queued = manager.submit(
        submission().model_copy(update={"package_name": "nnm_mnist_classifier"}),
        owner_connection_id=OWNER,
    )
    Path(queued.artifact_dir, "weights.safetensors").write_bytes(b"safe-weights")

    manager.run_once()

    status = manager.status(queued.id, owner_connection_id=OWNER)
    assert status.model_package is not None
    assert status.model_package.package_name == "nnm_mnist_classifier"
    assert any(event["type"] == "package_ready" for event in manager.events(queued.id, owner_connection_id=OWNER))


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


def test_manager_publishes_wandb_url_when_a_short_job_finishes_before_heartbeat(tmp_path):
    class WandbImmediateExecutor(ImmediateExecutor):
        def submit(self, job, artifact_dir, on_heartbeat, on_finished):
            stdout = Path(artifact_dir, "stdout.log")
            stdout.write_text("W&B URL: https://wandb.ai/team/project/runs/quick-run\n", encoding="utf-8")
            on_finished(0, {"stdout": str(stdout)})
            return {"worker": "test"}

    manager = JobManager(InMemoryJobStore(), tmp_path, [WandbImmediateExecutor()])
    queued = manager.submit(submission(), owner_connection_id=OWNER)

    manager.run_once()

    assert any(
        event["type"] == "wandb_ready"
        and event["wandb_url"] == "https://wandb.ai/team/project/runs/quick-run"
        for event in manager.events(queued.id, owner_connection_id=OWNER)
    )


def test_manager_skips_incompatible_high_priority_job(tmp_path):
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


def test_api_downloads_only_the_owner_model_wheel(tmp_path):
    store = InMemoryJobStore()
    manager = JobManager(store, tmp_path, [ImmediateExecutor()])
    auth = AuthService(InMemoryAuthStore())
    owner = auth.create_pairing("Owner", client_host="127.0.0.1")
    other = auth.create_pairing("Other", client_host="127.0.0.2")
    auth.approve(owner.request_id)
    auth.approve(other.request_id)
    job = manager.submit(submission(), owner_connection_id=owner.connection_id)
    record = store.get_job(job.id)
    assert record is not None
    artifact = Path(record["artifact_dir"])
    wheel = artifact / "dist" / "nnm-model.whl"
    wheel.parent.mkdir()
    wheel.write_bytes(b"wheel-content")
    record["model_package"] = {
        "schema_version": 1,
        "package_name": "nnm-model",
        "version": "0.1.0",
        "wheel": "dist/nnm-model.whl",
        "sha256": "checksum",
        "input_adapter": {"kind": "tensor", "version": 1},
    }
    store.save_job(job.id, record)
    app = create_app(manager, auth_service=auth, admin_token="admin-secret")

    async def exercise_api() -> None:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                owner_headers = {"authorization": f"Bearer {owner.token}"}
                other_headers = {"authorization": f"Bearer {other.token}"}
                response = await client.get(f"/jobs/{job.id}/package", headers=owner_headers)
                assert response.status_code == 200
                assert response.content == b"wheel-content"
                assert "attachment" in response.headers["content-disposition"]
                assert (await client.get(f"/jobs/{job.id}/package", headers=other_headers)).status_code == 404

    asyncio.run(exercise_api())


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
