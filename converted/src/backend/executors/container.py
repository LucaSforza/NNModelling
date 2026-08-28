"""Short-lived container executor for package jobs."""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable

from backend.container_controller import (
    CliEngineAdapter, ContainerCapabilityError, ContainerController, ContainerControllerClient, ContainerJobSpec,
)
from backend.executors.base import FinishedCallback, HeartbeatCallback
from backend.models import ResourceRequest


_IMAGE_DIGEST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[0-9a-f]{64}$")
_ENGINE_FORBIDDEN = re.compile(r"[;&|<>`]")


def _memory_gb() -> float:
    """Read host memory from Linux procfs, with a conservative fallback."""

    try:
        with open("/proc/meminfo", encoding="utf-8") as file:
            for line in file:
                if line.startswith("MemTotal:"):
                    return float(line.split()[1]) / 1024 / 1024
    except OSError:
        pass
    return 1.0


class ContainerExecutor:
    """Run a package worker in one disposable Podman/Docker-style container.

    The control-plane process only launches the configured engine executable. It
    never evaluates package Python itself. Input is staged in a separate
    read-only bind mount and artifacts are the only writable host mount.
    """

    name = "container"
    kind = "container"

    def __init__(
        self,
        *,
        engine: str | None = None,
        image: str | None = None,
        capacity: ResourceRequest | None = None,
        pid_limit: int | None = None,
        timeout_seconds: float | None = None,
        network: str | None = None,
        popen_factory: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
    ) -> None:
        self.engine = self._engine_argv(engine or os.environ.get("NNM_CONTAINER_ENGINE", "podman"))
        self.image = image or os.environ.get("NNM_CONTAINER_IMAGE")
        if not self.image or not _IMAGE_DIGEST.fullmatch(self.image):
            raise ValueError("NNM_CONTAINER_IMAGE must be an image@sha256:<64-hex-digest>")
        pid_limit = pid_limit if pid_limit is not None else int(os.environ.get("NNM_CONTAINER_PID_LIMIT", "256"))
        timeout_seconds = (
            timeout_seconds
            if timeout_seconds is not None
            else float(os.environ.get("NNM_CONTAINER_TIMEOUT_SECONDS", "3600"))
        )
        network = network or os.environ.get("NNM_CONTAINER_NETWORK", "none")
        if pid_limit < 1:
            raise ValueError("pid_limit must be positive")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if network != "none":
            raise ValueError("package workers require network='none'")
        self.capacity = capacity or ResourceRequest(
            cpu=os.cpu_count() or 1,
            memory_gb=_memory_gb(),
            gpu=0,
        )
        self.pid_limit = pid_limit
        self.timeout_seconds = timeout_seconds
        self.network = network
        self._popen_factory = popen_factory
        self._controller: ContainerController | None = None
        self._remote: ContainerControllerClient | None = None

    @staticmethod
    def _engine_argv(value: str) -> list[str]:
        """Parse an operator-configured engine/wrapper without invoking a shell."""

        if not value or chr(0) in value or _ENGINE_FORBIDDEN.search(value):
            raise ValueError("container engine contains unsupported shell characters")
        argv = shlex.split(value)
        if not argv or any(not part for part in argv):
            raise ValueError("container engine must not be empty")
        return argv

    def describe(self) -> dict[str, Any]:
        """Return the public compute-unit description."""

        return {
            "id": self.name,
            "kind": self.kind,
            "capacity": self.capacity.model_dump(mode="json"),
            "enabled": True,
            "engine": self.engine[0],
            "image": self.image,
            "network": self.network,
            "gpu": "unsupported; configure a dedicated GPU executor",
        }

    def can_run(self, resources: dict[str, Any]) -> bool:
        """Check CPU/RAM capacity and reject GPU until a device policy exists."""

        request = ResourceRequest.model_validate(resources)
        if request.gpu:
            return False
        if request.cpu > self.capacity.cpu or request.memory_gb > self.capacity.memory_gb:
            return False
        if request.gpu_type and self.capacity.gpu_type and request.gpu_type != self.capacity.gpu_type:
            return False
        return not request.node

    def build_command(self, job: dict[str, Any], artifact_dir: str | Path, input_dir: str | Path) -> list[str]:
        """Build the exact engine argv used for one package worker."""
        artifact_path, input_path = Path(artifact_dir), Path(input_dir)
        spec = self._spec(job, artifact_path, input_path)
        engine_kind = "docker" if Path(self.engine[0]).name == "docker" else "podman"
        return ContainerController(
            engine=CliEngineAdapter(engine_kind, executable=self.engine[0]),
            input_root=input_path.resolve().parent, artifact_root=artifact_path.resolve().parent,
        ).command(spec)

    def _controller_for(self, artifact_dir: Path, input_dir: Path) -> ContainerController:
        """Create the narrow controller for the two manager-owned roots."""

        # ``engine`` remains parsed here for manager compatibility; the
        # controller receives only the executable, never request data.
        # Wrapper commands retain Podman's secure defaults unless the invoked
        # executable is explicitly Docker.
        engine_kind = "docker" if Path(self.engine[0]).name == "docker" else "podman"
        adapter = CliEngineAdapter(engine_kind, executable=self.engine[0])
        # Production talks only to the operator-launched controller service.
        # An injected popen factory is retained strictly for unit tests and
        # never selects this branch in a deployed backend.
        if self._popen_factory is subprocess.Popen:
            socket_name = os.environ.get("NNM_CONTAINER_CONTROLLER_SOCKET")
            token_file = os.environ.get("NNM_CONTAINER_CONTROLLER_TOKEN_FILE")
            if not socket_name or not token_file:
                raise ContainerCapabilityError(
                    "container controller unavailable; configure its authenticated Unix socket"
                )
            try:
                token = Path(token_file).read_bytes()
            except OSError as exc:
                raise ContainerCapabilityError("container controller token unavailable") from exc
            if not token or len(token) > 128:
                raise ContainerCapabilityError("container controller token is invalid")
            try:
                text_token = token.strip().decode("ascii")
                if len(text_token) % 2 == 0 and text_token and all(c in "0123456789abcdefABCDEF" for c in text_token):
                    token = bytes.fromhex(text_token)
            except UnicodeDecodeError:
                pass
            if not token:
                raise ContainerCapabilityError("container controller token is invalid")
            self._remote = ContainerControllerClient(Path(socket_name), token)
            return None  # type: ignore[return-value]
        controller = ContainerController(
            engine=adapter,
            input_root=input_dir.resolve().parent,
            artifact_root=artifact_dir.resolve().parent,
            dataset_root=Path(os.environ["NNM_CONTAINER_DATA_ROOT"]).resolve()
            if os.environ.get("NNM_CONTAINER_DATA_ROOT") else None,
            popen=self._popen_factory,
        )
        self._controller = controller
        return controller

    def _spec(self, job: dict[str, Any], artifact_dir: str | Path, input_dir: str | Path) -> ContainerJobSpec:
        request = ResourceRequest.model_validate(job.get("resources", {}))
        if request.gpu:
            raise ValueError("GPU package jobs require a dedicated device policy")
        return ContainerJobSpec(
            job_id=str(job["id"]), image=self.image, input_dir=Path(input_dir), artifact_dir=Path(artifact_dir),
            cpu=request.cpu, memory_gb=request.memory_gb, pid_limit=self.pid_limit,
            timeout_seconds=self.timeout_seconds, network=self.network,
            dataset_dir=Path(os.environ["NNM_CONTAINER_DATA_ROOT"]).resolve()
            if os.environ.get("NNM_CONTAINER_DATA_ROOT") else None,
        )

    def submit(
        self,
        job: dict[str, Any],
        artifact_dir: str,
        on_heartbeat: HeartbeatCallback,
        on_finished: FinishedCallback,
    ) -> dict[str, Any]:
        """Start and monitor a package worker container."""

        job_id = str(job["id"])
        artifact_path = Path(artifact_dir).resolve()
        artifact_path.mkdir(parents=True, exist_ok=True)
        input_path = Path(job.get("package_input_dir", artifact_path.parent / f".{job_id}-input")).resolve()
        input_path.mkdir(parents=True, exist_ok=True)
        job_file = input_path / "job.json"
        if not job_file.exists():
            payload = dict(job)
            package_file = artifact_path / "package.json"
            if package_file.is_file():
                payload["package"] = json.loads(package_file.read_text(encoding="utf-8"))
            job_file.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
        controller = self._controller_for(artifact_path, input_path)
        if self._remote is not None:
            result = self._remote.submit(self._spec(job, artifact_path, input_path))
            threading.Thread(
                target=self._monitor_remote,
                args=(job_id, on_heartbeat, on_finished),
                daemon=True,
                name=f"nnm-controller-{job_id}",
            ).start()
            return result
        result = controller.submit(
            self._spec(job, artifact_path, input_path),
            on_heartbeat=on_heartbeat,
            on_finished=on_finished,
        )
        return result

    def _monitor_remote(self, job_id: str, on_heartbeat: HeartbeatCallback,
                        on_finished: FinishedCallback) -> None:
        assert self._remote is not None
        while True:
            status = self._remote.finished(job_id)
            if status.get("state") == "finished":
                on_finished(int(status["code"]), status)
                return
            on_heartbeat(self._remote.heartbeat(job_id))
            time.sleep(1)

    def cancel(self, job_id: str) -> bool:
        """Terminate the engine process group, which stops the container."""
        if self._remote is not None:
            return self._remote.cancel(job_id)
        return self._controller.cancel(job_id) if self._controller is not None else False
