"""Deprecated NNTree Slurm executor retained for compatibility jobs."""

# DEPRECATED: package jobs use the container boundary; retain this executor
# until legacy NNTree clients and their migration window are retired.

from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from backend.executors.base import FinishedCallback, HeartbeatCallback
from backend.models import ResourceRequest


class SlurmExecutor:
    """Submit generated batch scripts through ``sbatch``."""

    kind = "slurm"

    def __init__(
        self,
        converted_dir: str | Path,
        unit_id: str = "slurm-main",
        partition: str | None = None,
        account: str | None = None,
        ssh_host: str | None = None,
        project_dir: str | Path | None = None,
        capacity: ResourceRequest | None = None,
        poll_interval: float = 5.0,
    ) -> None:
        self.name = unit_id
        self.converted_dir = Path(converted_dir).resolve()
        self.project_dir = Path(project_dir or converted_dir).resolve()
        self.partition = partition
        self.account = account
        self.ssh_host = ssh_host
        self.capacity = capacity or ResourceRequest(cpu=1, memory_gb=1, gpu=1)
        self.poll_interval = poll_interval
        self._jobs: dict[str, str] = {}
        self._lock = threading.RLock()

    def describe(self) -> dict[str, Any]:
        """Return the public compute-unit description."""

        return {
            "id": self.name,
            "kind": self.kind,
            "capacity": self.capacity.model_dump(mode="json"),
            "enabled": True,
            "partition": self.partition,
            "ssh_host": self.ssh_host,
        }

    def can_run(self, resources: dict[str, Any]) -> bool:
        """Check static profile constraints before asking Slurm."""

        request = ResourceRequest.model_validate(resources)
        if request.gpu > self.capacity.gpu:
            return False
        if request.cpu > self.capacity.cpu or request.memory_gb > self.capacity.memory_gb:
            return False
        if request.gpu_type and self.capacity.gpu_type and request.gpu_type != self.capacity.gpu_type:
            return False
        return not request.node or request.node == self.name

    def build_batch_script(self, job: dict[str, Any], artifact_dir: str) -> str:
        """Generate a batch script from validated data, never user shell text."""

        request = ResourceRequest.model_validate(job["resources"])
        job_id = str(job["id"])
        artifact_path = Path(artifact_dir)
        lines = [
            "#!/bin/bash",
            "set -euo pipefail",
            f"#SBATCH --job-name=nnm-{job_id[:12]}",
            f"#SBATCH --cpus-per-task={request.cpu}",
            f"#SBATCH --mem={request.memory_gb:g}G",
            f"#SBATCH --output={artifact_path / 'stdout.log'}",
            f"#SBATCH --error={artifact_path / 'stderr.log'}",
        ]
        if request.gpu:
            gpu_spec = f"{request.gpu_type + ':' if request.gpu_type else ''}{request.gpu}"
            lines.append(f"#SBATCH --gres=gpu:{gpu_spec}")
        if request.node:
            lines.append(f"#SBATCH --nodelist={request.node}")
        if self.partition:
            lines.append(f"#SBATCH --partition={self.partition}")
        if self.account:
            lines.append(f"#SBATCH --account={self.account}")
        lines.extend(
            [
                "",
                f"cd {self.project_dir}",
                "exec python src/main.py "
                f"--config-path {artifact_path / 'cfg'} --config-name base "
                f"hydra.run.dir={artifact_path} hydra.job.chdir=true "
                f"+trainer.default_root_dir={artifact_path} "
                "+trainer.enable_progress_bar=false",
                "",
            ]
        )
        return "\n".join(lines)

    def _submit_script(self, script: str) -> str:
        """Submit via local sbatch or SSH without shell interpolation."""

        command = ["sbatch", "--parsable"]
        if self.ssh_host:
            command = ["ssh", self.ssh_host, "sbatch", "--parsable"]
        result = subprocess.run(command, input=script, text=True, capture_output=True, check=True)
        return result.stdout.strip().split(";")[0]

    def _query_state(self, slurm_id: str) -> str:
        """Return a normalized Slurm state."""

        prefix = ["ssh", self.ssh_host] if self.ssh_host else []
        result = subprocess.run(
            [*prefix, "squeue", "-h", "-j", slurm_id, "-o", "%T"],
            text=True,
            capture_output=True,
            check=False,
        )
        state = result.stdout.strip().upper()
        if state:
            return state
        result = subprocess.run(
            [*prefix, "sacct", "-X", "-j", slurm_id, "-o", "State", "-n"],
            text=True,
            capture_output=True,
            check=False,
        )
        return result.stdout.strip().split()[0].upper() if result.stdout.strip() else "UNKNOWN"

    def submit(
        self,
        job: dict[str, Any],
        artifact_dir: str,
        on_heartbeat: HeartbeatCallback,
        on_finished: FinishedCallback,
    ) -> dict[str, Any]:
        """Write and submit a batch script, then monitor its Slurm state."""

        job_id = str(job["id"])
        artifact_path = Path(artifact_dir)
        artifact_path.mkdir(parents=True, exist_ok=True)
        script = self.build_batch_script(job, artifact_dir)
        script_path = artifact_path / "batch.sh"
        script_path.write_text(script, encoding="utf-8")
        slurm_id = self._submit_script(script)
        with self._lock:
            self._jobs[job_id] = slurm_id

        def monitor() -> None:
            terminal_success = {"COMPLETED"}
            terminal_failure = {"FAILED", "CANCELLED", "TIMEOUT", "NODE_FAIL", "OUT_OF_MEMORY"}
            while True:
                state = self._query_state(slurm_id)
                on_heartbeat({"slurm_id": slurm_id, "state": state, "executor": self.name})
                if state in terminal_success | terminal_failure:
                    with self._lock:
                        self._jobs.pop(job_id, None)
                    on_finished(
                        0 if state in terminal_success else 1,
                        {
                            "slurm_id": slurm_id,
                            "state": state,
                            "stdout": str(artifact_path / "stdout.log"),
                            "stderr": str(artifact_path / "stderr.log"),
                        },
                    )
                    return
                time.sleep(self.poll_interval)

        threading.Thread(target=monitor, name=f"nnm-slurm-{job_id}", daemon=True).start()
        return {"slurm_id": slurm_id, "script": str(script_path)}

    def cancel(self, job_id: str) -> bool:
        """Cancel a submitted Slurm job."""

        with self._lock:
            slurm_id = self._jobs.get(job_id)
        if not slurm_id:
            return False
        command = (["ssh", self.ssh_host] if self.ssh_host else []) + ["scancel", slurm_id]
        subprocess.run(command, check=False, capture_output=True, text=True)
        return True
