"""Focused tests for safe package-container command construction."""

from __future__ import annotations

import json
from pathlib import Path
from threading import Event

import pytest

from backend.executors.container import ContainerExecutor
from backend.container_controller import ContainerCapabilityError


IMAGE = "registry.example/nnm-worker@sha256:" + "a" * 64


def test_build_command_is_explicit_and_mounts_input_read_only(tmp_path: Path) -> None:
    input_dir = tmp_path / "input"
    artifact_dir = tmp_path / "artifacts"
    input_dir.mkdir()
    artifact_dir.mkdir()
    executor = ContainerExecutor(engine="docker-podman", image=IMAGE, pid_limit=32)

    command = executor.build_command({"id": "job-1", "resources": {"cpu": 2, "memory_gb": 3}}, artifact_dir, input_dir)

    assert command[:1] == ["docker-podman"]
    assert "--network" in command and command[command.index("--network") + 1] == "none"
    assert "--read-only" in command
    mounts = [command[index + 1] for index, value in enumerate(command) if value == "--mount"]
    assert any("dst=/input,readonly" in mount for mount in mounts)
    assert any("dst=/artifacts" in mount and "readonly" not in mount for mount in mounts)
    assert command[-7:] == ["/app/.venv/bin/python", "-m", "package_worker", "--input", "/input/job.json", "--artifacts", "/artifacts"]


def test_rejects_unpinned_images_and_shell_engine_values() -> None:
    with pytest.raises(ValueError, match="sha256"):
        ContainerExecutor(image="nnm-worker:latest")
    with pytest.raises(ValueError, match="shell"):
        ContainerExecutor(engine="podman; touch /tmp/pwned", image=IMAGE)


def test_gpu_is_not_claimed_without_device_policy() -> None:
    executor = ContainerExecutor(image=IMAGE)
    assert not executor.can_run({"gpu": 1})
    with pytest.raises(ValueError, match="GPU"):
        executor.build_command({"id": "job-1", "resources": {"gpu": 1}}, "/tmp/artifacts", "/tmp/input")


def test_package_worker_reads_training_from_backend_submission_envelope() -> None:
    from package_worker import _training_config

    request = {"submission": {"training": {"trainer": {"max_epochs": 5}}}}

    assert _training_config(request)["trainer"]["max_epochs"] == 5


def test_submit_uses_fake_engine_and_reports_completion(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeProcess:
        pid = 1234
        returncode = 0

        def poll(self) -> int:
            return self.returncode

        def wait(self, timeout: float | None = None) -> int:
            del timeout
            return self.returncode

    calls: list[list[str]] = []
    finished = Event()
    results: list[tuple[int, dict[str, object]]] = []

    def fake_popen(command: list[str], **kwargs: object) -> FakeProcess:
        del kwargs
        calls.append(command)
        return FakeProcess()

    monkeypatch.setattr("backend.container_controller.shutil_which", lambda _binary: "/usr/bin/podman")
    executor = ContainerExecutor(image=IMAGE, popen_factory=fake_popen)
    result = executor.submit(
        {"id": "job-1", "resources": {}},
        str(tmp_path / "artifacts"),
        lambda _event: None,
        lambda code, metadata: (results.append((code, metadata)), finished.set()),
    )

    assert finished.wait(1)
    assert result["pid"] == 1234
    assert calls[0][-7:] == ["/app/.venv/bin/python", "-m", "package_worker", "--input", "/input/job.json", "--artifacts", "/artifacts"]
    assert results[0][0] == 0


def test_executor_propagates_controller_capability_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("backend.container_controller.shutil_which", lambda _binary: None)
    executor = ContainerExecutor(image=IMAGE)
    with pytest.raises(ContainerCapabilityError, match="unavailable"):
        executor.submit(
            {"id": "job-unavailable", "resources": {}}, str(tmp_path / "artifacts"),
            lambda _event: None, lambda _code, _metadata: None,
        )


def test_executor_delegates_process_start_to_controller(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    executor = ContainerExecutor(image=IMAGE)
    calls: list[object] = []

    class Controller:
        def submit(self, spec: object, **callbacks: object) -> dict[str, object]:
            calls.append((spec, callbacks))
            return {"pid": 7}

        def command(self, spec: object) -> list[str]:
            return ["podman", "run", spec.job_id]  # type: ignore[attr-defined]

        def cancel(self, job_id: str) -> bool:
            calls.append(job_id)
            return True

    controller = Controller()
    monkeypatch.setattr(executor, "_controller_for", lambda *_args: controller)
    executor._controller = controller
    result = executor.submit(
        {"id": "job-delegated", "resources": {}}, str(tmp_path / "artifacts"),
        lambda _event: None, lambda _code, _metadata: None,
    )
    assert result == {"pid": 7}
    assert len(calls) == 1
    assert executor.cancel("job-delegated") is True


def test_remote_controller_does_not_require_engine_binary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class Remote:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass
        def submit(self, _spec: object) -> dict[str, object]:
            return {"pid": 7}
        def finished(self, _job_id: str) -> dict[str, object]:
            return {"state": "finished", "code": 0}
        def heartbeat(self, _job_id: str) -> dict[str, object]:
            return {"controller": "container"}
        def cancel(self, _job_id: str) -> bool:
            return True

    monkeypatch.setenv("NNM_CONTAINER_CONTROLLER_SOCKET", str(tmp_path / "controller.sock"))
    token_file = tmp_path / "token"
    token_file.write_text("00" * 32, encoding="ascii")
    monkeypatch.setenv("NNM_CONTAINER_CONTROLLER_TOKEN_FILE", str(token_file))
    monkeypatch.setattr("backend.executors.container.ContainerControllerClient", Remote)
    monkeypatch.setattr("backend.container_controller.shutil_which", lambda _binary: None)
    executor = ContainerExecutor(engine="missing-engine", image=IMAGE)
    result = executor.submit(
        {"id": "remote-job", "resources": {}}, str(tmp_path / "artifacts"),
        lambda _event: None, lambda _code, _metadata: None,
    )
    assert result == {"pid": 7}
