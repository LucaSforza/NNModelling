"""Focused tests for safe package-container command construction."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from threading import Event

import pytest

from backend.executors.container import ContainerExecutor


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


def test_worker_loads_declared_package(tmp_path: Path) -> None:
    from package_worker import run

    package_root = tmp_path / "packages" / "demo" / "1.0.0"
    package_root.mkdir(parents=True)
    (package_root / "manifest.json").write_text(json.dumps({"id": "demo", "version": "1.0.0"}), encoding="utf-8")
    (package_root / "pytorch.py").write_text(
        "def build(parameters, context, services):\n    return object()\n", encoding="utf-8"
    )
    input_path = tmp_path / "job.json"
    input_path.write_text(json.dumps({"packages": [{"id": "demo", "version": "1.0.0"}]}), encoding="utf-8")

    result = run(input_path, tmp_path / "artifacts")

    assert result["packages"] == [{"id": "demo", "version": "1.0.0"}]


def test_package_worker_writes_downloadable_training_archive(tmp_path: Path) -> None:
    from package_worker import _write_trained_package

    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    for name in ("weights.safetensors", "training-summary.json", "package-worker-result.json"):
        (artifacts / name).write_text(name, encoding="utf-8")

    manifest = {"packages": [{"id": "demo", "version": "1.0.0"}]}
    result = _write_trained_package(manifest, artifacts)

    assert result["format"] == "nnm-trained-package/v1"
    assert result["size"] == (artifacts / "trained-package.zip").stat().st_size
    with zipfile.ZipFile(artifacts / "trained-package.zip") as archive:
        assert set(archive.namelist()) == {
            "package.json",
            "weights.safetensors",
            "training-summary.json",
            "package-worker-result.json",
        }


def test_package_worker_reads_training_from_backend_submission_envelope() -> None:
    from package_worker import _training_config

    request = {"submission": {"training": {"trainer": {"max_epochs": 5}}}}

    assert _training_config(request)["trainer"]["max_epochs"] == 5


def test_submit_uses_fake_engine_and_reports_completion(tmp_path: Path) -> None:
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
