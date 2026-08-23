"""Short-lived container executor for package jobs."""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable

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
        if network not in {"none", "bridge"}:
            raise ValueError("network must be 'none' or 'bridge'")
        self.capacity = capacity or ResourceRequest(
            cpu=os.cpu_count() or 1,
            memory_gb=_memory_gb(),
            gpu=0,
        )
        self.pid_limit = pid_limit
        self.timeout_seconds = timeout_seconds
        self.network = network
        self._popen_factory = popen_factory
        self._processes: dict[str, subprocess.Popen[bytes]] = {}
        self._lock = threading.RLock()

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

        request = ResourceRequest.model_validate(job.get("resources", {}))
        if request.gpu:
            raise ValueError("GPU package jobs require a dedicated device policy")
        job_id = str(job["id"])
        artifact_path = Path(artifact_dir).resolve()
        input_path = Path(input_dir).resolve()
        return [
            *self.engine,
            "run",
            "--rm",
            "--name",
            f"nnm-package-{job_id[:32]}",
            "--read-only",
            "--network",
            self.network,
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            str(self.pid_limit),
            "--cpus",
            str(request.cpu),
            "--memory",
            f"{request.memory_gb:g}g",
            "--mount",
            f"type=bind,src={input_path},dst=/input,readonly",
            "--mount",
            f"type=bind,src={artifact_path},dst=/artifacts",
            *self._data_mount(),
            self.image,
            "/app/.venv/bin/python",
            "-m",
            "package_worker",
            "--input",
            "/input/job.json",
            "--artifacts",
            "/artifacts",
        ]

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
        stdout_file = artifact_path / "stdout.log"
        stderr_file = artifact_path / "stderr.log"
        stdout = stdout_file.open("ab")
        stderr = stderr_file.open("ab")
        command = self.build_command(job, artifact_path, input_path)
        try:
            process = self._popen_factory(
                command,
                stdout=stdout,
                stderr=stderr,
                start_new_session=True,
            )
        except Exception:
            stdout.close()
            stderr.close()
            raise
        stdout.close()
        stderr.close()
        with self._lock:
            self._processes[job_id] = process
        started = time.monotonic()

        def monitor() -> None:
            timed_out = False
            while process.poll() is None:
                if time.monotonic() - started >= self.timeout_seconds:
                    timed_out = True
                    self.cancel(job_id)
                    break
                on_heartbeat({"pid": process.pid, "executor": self.name})
                time.sleep(1.0)
            return_code = process.returncode if process.returncode is not None else 1
            on_heartbeat({"pid": process.pid, "executor": self.name, "finished": True, "timed_out": timed_out})
            with self._lock:
                self._processes.pop(job_id, None)
            if "package_input_dir" not in job:
                shutil.rmtree(input_path, ignore_errors=True)
            on_finished(
                return_code,
                {
                    "pid": process.pid,
                    "stdout": str(stdout_file),
                    "stderr": str(stderr_file),
                    "timed_out": timed_out,
                    "command": command,
                },
            )

        threading.Thread(target=monitor, name=f"nnm-container-{job_id}", daemon=True).start()
        return {"pid": process.pid, "stdout": str(stdout_file), "stderr": str(stderr_file), "command": command}

    @staticmethod
    def _data_mount() -> list[str]:
        """Expose a pre-staged local dataset read-only inside the worker."""

        data_root = os.environ.get("NNM_CONTAINER_DATA_ROOT")
        if not data_root or not Path(data_root).is_dir():
            return []
        return [
            "--mount",
            f"type=bind,src={Path(data_root).resolve()},dst=/app/data,readonly",
        ]

    def cancel(self, job_id: str) -> bool:
        """Terminate the engine process group, which stops the container."""

        with self._lock:
            process = self._processes.get(job_id)
        if process is None or process.poll() is not None:
            return False
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return False
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                return False
            process.wait(timeout=5)
        return True
