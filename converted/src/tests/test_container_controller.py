from __future__ import annotations

import os
import socket
import threading
import time
from pathlib import Path

import pytest

from backend.container_controller import (
    CliEngineAdapter,
    ContainerCapabilityError,
    ContainerController,
    ContainerJobSpec,
    ContainerControllerClient,
    _load_token_argument,
    serve_unix,
)


IMAGE = "registry.example/nnm-worker@sha256:" + "a" * 64


def spec(tmp_path: Path) -> ContainerJobSpec:
    return ContainerJobSpec("vae-1", IMAGE, tmp_path / "inputs" / "vae-1", tmp_path / "artifacts" / "vae-1")


def test_podman_and_docker_share_least_privilege_command(tmp_path: Path) -> None:
    request = spec(tmp_path)
    for name in ("podman", "docker"):
        command = CliEngineAdapter(name).command(request)
        assert command[0] == name
        assert "--read-only" in command
        assert command[command.index("--network") + 1] == "none"
        assert command[command.index("--cap-drop") + 1] == "ALL"
        assert "--user" in command and command[command.index("--user") + 1] == f"{os.getuid()}:{os.getgid()}"
        mounts = [command[i + 1] for i, value in enumerate(command) if value == "--mount"]
        assert any("dst=/input,readonly" in mount for mount in mounts)
        assert any("dst=/artifacts" in mount and "readonly" not in mount for mount in mounts)
        assert command[-7:] == ["/app/.venv/bin/python", "-m", "package_worker", "--input", "/input/job.json", "--artifacts", "/artifacts"]


def test_preprovisioned_dataset_is_read_only_and_not_networked(tmp_path: Path) -> None:
    data = tmp_path / "dataset"
    data.mkdir()
    request = ContainerJobSpec(
        "vae-1", IMAGE, tmp_path / "inputs" / "vae-1", tmp_path / "artifacts" / "vae-1", dataset_dir=data
    )
    command = CliEngineAdapter("podman").command(request)
    mounts = [command[i + 1] for i, value in enumerate(command) if value == "--mount"]
    assert f"type=bind,src={data},dst=/app/data,readonly" in mounts
    assert command[command.index("--env") + 1:] != []
    assert command[command.index("--env") + 1] == "NNM_DATASET_ROOT=/app/data"
    assert command[command.index("--network") + 1] == "none"


def test_spec_rejects_unpinned_image_and_path_escape(tmp_path: Path) -> None:
    request = spec(tmp_path)
    with pytest.raises(ValueError, match="sha256"):
        ContainerJobSpec(request.job_id, "worker:latest", request.input_dir, request.artifact_dir).validate(
            input_root=tmp_path / "inputs", artifact_root=tmp_path / "artifacts"
        )
    escaped = ContainerJobSpec(request.job_id, IMAGE, tmp_path / "outside", request.artifact_dir)
    with pytest.raises(ValueError, match="escapes"):
        escaped.validate(input_root=tmp_path / "inputs", artifact_root=tmp_path / "artifacts")


def test_controller_fails_explicitly_when_engine_is_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("backend.container_controller.shutil_which", lambda _binary: None)
    controller = ContainerController(engine=CliEngineAdapter("podman"), input_root=tmp_path / "inputs", artifact_root=tmp_path / "artifacts")
    with pytest.raises(ContainerCapabilityError, match="unavailable"):
        controller.submit(spec(tmp_path), on_heartbeat=lambda _event: None, on_finished=lambda *_args: None)


def test_controller_starts_fake_vae_worker_and_reports_completion(tmp_path: Path) -> None:
    class Process:
        pid = 42
        returncode = 0

        def poll(self) -> int:
            return self.returncode

        def wait(self, timeout: float | None = None) -> int:
            del timeout
            return self.returncode

    calls: list[list[str]] = []
    controller = ContainerController(
        engine=CliEngineAdapter("podman"), input_root=tmp_path / "inputs", artifact_root=tmp_path / "artifacts",
        popen=lambda command, **_kwargs: (calls.append(command) or Process()),
    )
    import backend.container_controller as module
    old = module.shutil_which
    module.shutil_which = lambda _binary: "/usr/bin/podman"
    try:
        finished: list[int] = []
        result = controller.submit(spec(tmp_path), on_heartbeat=lambda _event: None, on_finished=lambda code, _meta: finished.append(code))
        assert result["pid"] == 42
        assert calls and calls[0][-7:-4] == ["/app/.venv/bin/python", "-m", "package_worker"]
        assert finished == [0]
    finally:
        module.shutil_which = old


def test_authenticated_socket_exposes_lifecycle_without_engine_flags(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    probe = tmp_path / "socket-probe"
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.bind(str(probe))
    except PermissionError:
        pytest.skip("sandbox does not permit Unix-domain socket bind")
    finally:
        probe.unlink(missing_ok=True)
    class Process:
        pid = 9
        returncode = 0
        def poll(self) -> int: return self.returncode
        def wait(self, timeout: float | None = None) -> int:
            del timeout
            return self.returncode

    monkeypatch.setattr("backend.container_controller.shutil_which", lambda _binary: "/bin/fake")
    controller = ContainerController(
        engine=CliEngineAdapter("podman", executable="fake"),
        input_root=tmp_path / "inputs", artifact_root=tmp_path / "artifacts",
        popen=lambda command, **_kwargs: Process(),
    )
    socket_path = tmp_path / "controller.sock"
    token = b"secret"
    thread = threading.Thread(target=serve_unix, args=(controller, socket_path), kwargs={"token": token}, daemon=True)
    thread.start()
    for _ in range(100):
        if socket_path.exists(): break
        time.sleep(0.01)
    client = ContainerControllerClient(socket_path, token)
    result = client.submit(spec(tmp_path))
    assert result["pid"] == 9
    assert client.finished("vae-1")["state"] == "finished"
    assert client.heartbeat("vae-1")["job_id"] == "vae-1"
    unauthorized = ContainerControllerClient(socket_path, b"wrong")
    with pytest.raises(Exception, match="unauthorized"):
        unauthorized.status("vae-1")


def test_dataset_mount_must_be_under_operator_root(tmp_path: Path) -> None:
    dataset_root = tmp_path / "datasets"
    dataset_root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    request = ContainerController(
        engine=CliEngineAdapter("podman"), input_root=tmp_path / "inputs",
        artifact_root=tmp_path / "artifacts", dataset_root=dataset_root,
    )
    with pytest.raises(ValueError, match="dataset_dir escapes"):
        request.command(ContainerJobSpec("job", IMAGE, tmp_path / "inputs" / "job",
                                         tmp_path / "artifacts" / "job", dataset_dir=outside))


def test_compose_gives_engine_socket_only_to_controller() -> None:
    compose = Path(__file__).parents[2] / "backend" / "docker-compose.yml"
    text = compose.read_text(encoding="utf-8")
    backend = text.split("\n  controller:\n", 1)[0]
    controller = text.split("\n  controller:\n", 1)[1]
    socket_marker = "NNM_CONTAINER_ENGINE_SOCKET"
    assert socket_marker not in backend
    assert socket_marker in controller
    assert "NNM_CONTAINER_CONTROLLER_SOCKET" in backend
    assert "controller-socket:/run/nnm:ro" in backend
    assert '"${NNM_CONTAINER_ENGINE:-podman}"' in controller


def test_controller_loads_hex_token_from_at_file(tmp_path: Path) -> None:
    token = bytes(range(32))
    token_file = tmp_path / "controller.token"
    token_file.write_text(token.hex() + "\n", encoding="ascii")
    assert _load_token_argument("@" + str(token_file)) == token
    assert _load_token_argument(token.hex()) == token
    with pytest.raises(ValueError, match="exactly 32"):
        _load_token_argument("00")
