"""Local subprocess executor."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from backend.executors.base import FinishedCallback, HeartbeatCallback
from backend.models import ResourceRequest


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


class LocalExecutor:
    """Run one Hydra training process on the backend host."""

    name = "local"
    kind = "local"

    def __init__(self, converted_dir: str | Path, capacity: ResourceRequest | None = None) -> None:
        self.converted_dir = Path(converted_dir).resolve()
        self.capacity = capacity or ResourceRequest(
            cpu=os.cpu_count() or 1,
            memory_gb=_memory_gb(),
            gpu=0,
        )
        self._processes: dict[str, subprocess.Popen[bytes]] = {}
        self._lock = threading.RLock()

    def describe(self) -> dict[str, Any]:
        """Return the public compute-unit description."""

        return {
            "id": self.name,
            "kind": self.kind,
            "capacity": self.capacity.model_dump(mode="json"),
            "enabled": True,
        }

    def can_run(self, resources: dict[str, Any]) -> bool:
        """Check whether a request fits the local host profile."""

        request = ResourceRequest.model_validate(resources)
        if request.gpu > self.capacity.gpu:
            return False
        if request.cpu > self.capacity.cpu or request.memory_gb > self.capacity.memory_gb:
            return False
        if request.gpu_type and self.capacity.gpu_type and request.gpu_type != self.capacity.gpu_type:
            return False
        return not request.node

    def _command(self, job: dict[str, Any], artifact_dir: Path, project: dict[str, Any] | None = None) -> list[str]:
        """Build the fixed training command for a submitted job.

        Project-scoped jobs run with the project's own venv interpreter;
        legacy jobs keep the companion interpreter.
        """

        cfg_dir = artifact_dir / "cfg"
        python = project["python"] if project else sys.executable
        return [
            python,
            str(self.converted_dir / "src" / "main.py"),
            "--config-path",
            str(cfg_dir),
            "--config-name",
            "base",
            f"hydra.run.dir={artifact_dir}",
            "hydra.job.chdir=true",
            f"+trainer.default_root_dir={artifact_dir}",
            "+trainer.enable_progress_bar=false",
        ]

    def submit(
        self,
        job: dict[str, Any],
        artifact_dir: str,
        on_heartbeat: HeartbeatCallback,
        on_finished: FinishedCallback,
        project: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Start a local process and monitor it until completion.

        The optional ``project`` context carries the resolved project root,
        interpreter, and the complete child environment (project ``src/`` and
        ``datasets/`` import roots plus the W&B API key). Legacy jobs inherit
        the parent environment exactly as before.
        """

        job_id = str(job["id"])
        artifact_path = Path(artifact_dir)
        artifact_path.mkdir(parents=True, exist_ok=True)
        stdout_file = artifact_path / "stdout.log"
        stderr_file = artifact_path / "stderr.log"
        stdout = stdout_file.open("ab")
        stderr = stderr_file.open("ab")
        try:
            process = subprocess.Popen(
                self._command(job, artifact_path, project),
                cwd=self.converted_dir,
                stdout=stdout,
                stderr=stderr,
                env=project["env"] if project else None,
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

        def monitor() -> None:
            while process.poll() is None:
                on_heartbeat({"pid": process.pid, "executor": self.name})
                time.sleep(1.0)
            return_code = process.returncode or 0
            on_heartbeat({"pid": process.pid, "executor": self.name, "finished": True})
            with self._lock:
                self._processes.pop(job_id, None)
            on_finished(
                return_code,
                {
                    "pid": process.pid,
                    "stdout": str(stdout_file),
                    "stderr": str(stderr_file),
                },
            )

        threading.Thread(target=monitor, name=f"nnm-local-{job_id}", daemon=True).start()
        return {"pid": process.pid, "stdout": str(stdout_file), "stderr": str(stderr_file)}

    def cancel(self, job_id: str) -> bool:
        """Terminate a local process group."""

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
