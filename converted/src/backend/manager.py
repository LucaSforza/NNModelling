"""Job lifecycle manager and single-queue scheduler."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from backend.config_service import build_job_hydra_configs
from backend.executors import Executor, LocalExecutor, SlurmExecutor
from backend.models import JobStatus, JobSubmission, ResourceRequest
from backend.project_env import project_python
from backend.project_schema import ProjectSummary, WandbSettings
from backend.store import JobStore, ValkeyJobStore, utc_now
from model_package.exporter import build_model_wheel


TERMINAL_STATES = {"succeeded", "failed", "cancelled"}


class ProjectResolver(Protocol):
    """Narrow project service contract consumed for project-scoped jobs.

    The S1 ``ProjectManager`` satisfies this protocol: project ids resolve
    only through its companion-owned recent-project registry, never through
    client-supplied filesystem paths.
    """

    def get_project(self, project_id: str) -> ProjectSummary:
        """Return the public summary for one registered project."""
        ...

    def resolve_root(self, project_id: str) -> Path:
        """Resolve a registered project's root for job execution."""
        ...

    def wandb_api_key(self, project_id: str) -> str | None:
        """Return the stored W&B API key for a child process, if any."""
        ...


@dataclass(frozen=True)
class _ProjectJob:
    """Non-secret project context resolved for one job submission.

    The W&B API key is deliberately absent: it is resolved only at execution
    time and injected solely into the child process environment.
    """

    project_id: str
    root: Path
    settings: WandbSettings

# The failed transition is persisted atomically by the store (record update +
# queue removal in one operation). A bounded retry heals transient store
# failures; a persistent failure raises so the job keeps a recoverable running
# state instead of a partial transition.
FAILED_TRANSITION_ATTEMPTS = 3
FAILED_TRANSITION_BACKOFF_SECONDS = 0.2

# Authoritative wheel digests are lowercase hex SHA-256 strings. Anything else
# is a corrupt manifest that must never be served.
PACKAGE_SHA256_HEX = re.compile(r"[0-9a-fA-F]{64}\Z")

# Downloads are pinned to an immutable backend-private snapshot streamed in
# bounded chunks, so a wheel is never loaded into memory on either the
# copy-and-hash side or the serve side.
PACKAGE_SNAPSHOT_CHUNK_SIZE = 1024 * 1024


class PackageIntegrityError(Exception):
    """Raised when an exported wheel no longer matches its declared digest.

    The message is deliberately generic: it never includes filesystem paths,
    so the download endpoint can surface it to clients without leaking where
    job artifacts are stored.
    """


class JobManager:
    """Persist jobs, schedule them by priority, and run one at a time."""

    def __init__(
        self,
        store: JobStore,
        artifact_root: str | Path,
        executors: list[Executor],
        max_running_jobs: int = 1,
        poll_interval: float = 0.25,
        *,
        package_snapshot_dir: str | Path | None = None,
        project_manager: ProjectResolver | None = None,
    ) -> None:
        if not executors:
            raise ValueError("At least one executor is required")
        self.store = store
        self.artifact_root = Path(artifact_root).resolve()
        self.artifact_root.mkdir(parents=True, exist_ok=True)
        self.executors = executors
        self.max_running_jobs = max_running_jobs
        self.poll_interval = poll_interval
        # Resolver for optional project-scoped jobs; project ids are resolved
        # only through this injected service (never a client filesystem path).
        self.project_manager = project_manager
        # Private directory for immutable download snapshots. When unset the
        # OS temporary directory is used (mkstemp files are created ``0600``);
        # the directory is never exposed through any API path.
        self.package_snapshot_dir = (
            Path(package_snapshot_dir) if package_snapshot_dir is not None else None
        )
        self._active: dict[str, tuple[Executor, dict[str, Any]]] = {}
        self._round_robin_cursor = 0
        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    @classmethod
    def from_environment(cls, *, project_manager: ProjectResolver | None = None) -> "JobManager":
        """Build a production manager from backend environment variables.

        The optional ``project_manager`` wires the companion project service
        so ``project_id`` submissions can resolve registered project workspaces.
        """

        converted_dir = Path(
            os.getenv("NNM_CONVERTED_DIR", Path(__file__).resolve().parents[2])
        ).expanduser().resolve()
        default_artifact_root = converted_dir / "jobs"
        artifact_root = Path(
            os.getenv("NNM_BACKEND_ARTIFACT_ROOT", str(default_artifact_root))
        ).expanduser().resolve()
        store = ValkeyJobStore(os.getenv("NNM_VALKEY_URL", "valkey://127.0.0.1:6379/0"))
        executors: list[Executor] = [LocalExecutor(converted_dir)]
        if os.getenv("NNM_ENABLE_SLURM", "0").lower() in {"1", "true", "yes"}:
            slurm_gpu_type = os.getenv("NNM_SLURM_GPU_TYPE") or None
            executors.append(
                SlurmExecutor(
                    converted_dir,
                    unit_id=os.getenv("NNM_SLURM_UNIT_ID", "slurm-main"),
                    partition=os.getenv("NNM_SLURM_PARTITION"),
                    account=os.getenv("NNM_SLURM_ACCOUNT"),
                    ssh_host=os.getenv("NNM_SLURM_SSH_HOST"),
                    project_dir=os.getenv("NNM_SLURM_PROJECT_DIR", str(converted_dir)),
                    capacity=ResourceRequest(
                        cpu=int(os.getenv("NNM_SLURM_CPU", "1")),
                        memory_gb=float(os.getenv("NNM_SLURM_MEMORY_GB", "1")),
                        gpu=int(os.getenv("NNM_SLURM_GPU", "1")),
                        gpu_type=slurm_gpu_type,
                    ),
                )
            )
        return cls(store, artifact_root, executors, project_manager=project_manager)

    def start(self) -> None:
        """Start the scheduler thread and recover persisted queue metadata."""

        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._recover()
            self._stop_event.clear()
            self._thread = threading.Thread(target=self._run, name="nnm-scheduler", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        """Stop scheduling and terminate executions owned by this manager."""

        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=2)
        with self._lock:
            active_jobs = list(self._active.items())
            self._active.clear()
        for job_id, (executor, _handle) in active_jobs:
            job = self.store.get_job(job_id)
            if job is None or job.get("status") in TERMINAL_STATES:
                continue
            try:
                executor.cancel(job_id)
                error = "Backend stopped and cancelled the active execution; job must be resubmitted."
            except Exception as exc:
                error = f"Backend stopped before active execution could be cancelled: {exc}"
            self._set_status(job_id, "failed", finished_at=utc_now(), error=error)
            self._event(job_id, "failed", {"error": error})

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.run_once()
            except Exception:
                # A scheduler loop must remain alive; the job-specific error
                # is recorded by submit/finish paths whenever possible.
                pass
            self._stop_event.wait(self.poll_interval)

    def _recover(self) -> None:
        """Restore queued jobs and fail unverifiable pre-restart executions."""

        for job in self.store.list_jobs():
            status = job.get("status")
            if status == "queued":
                self.store.enqueue(job["id"], int(job["priority"]), job["created_at"])
            elif status == "running":
                error = "Backend restarted while the execution was running; job must be resubmitted."
                self._set_status(
                    job["id"],
                    "failed",
                    finished_at=utc_now(),
                    error=error,
                )
                self._event(job["id"], "failed", {"error": error})

    def submit(self, submission: JobSubmission, *, owner_connection_id: str) -> JobStatus:
        """Validate, materialize and enqueue a complete job document.

        When the submission names a project, the project is resolved through
        the injected project service before any artifact exists: unknown
        projects, unavailable environments, and backends without a local
        executor are rejected up front. Project artifacts are stored under
        ``<project>/runs/<job-id>`` and the project's non-secret W&B settings
        act as defaults that explicit job settings override.
        """

        job_id = str(uuid.uuid4())
        created_at = utc_now()
        project = (
            self._resolve_project_job(submission.project_id)
            if submission.project_id is not None
            else None
        )
        artifact_dir = self._artifact_dir_for(job_id, project)
        artifact_dir.mkdir(parents=True, exist_ok=True)
        payload = submission.model_dump(mode="json")
        payload["id"] = job_id
        payload["created_at"] = created_at
        payload["artifact_dir"] = str(artifact_dir)
        if project is not None:
            payload["training"]["wandb"] = _merge_wandb_defaults(
                project.settings,
                payload["training"].get("wandb", {}),
            )
        requested_path = artifact_dir / "requested_config.json"
        requested_path.write_text(json.dumps(submission.model_dump(mode="json"), indent=2), encoding="utf-8")
        build_job_hydra_configs(
            payload,
            artifact_dir,
            import_roots=((project.root / "datasets",) if project is not None else ()),
        )
        record = {
            "id": job_id,
            "status": "queued",
            "priority": submission.priority,
            "created_at": created_at,
            "started_at": None,
            "finished_at": None,
            "executor": None,
            "compute_unit": None,
            "error": None,
            "heartbeat_at": None,
            "wandb_url": None,
            "model_package": None,
            "package_error": None,
            "artifact_dir": str(artifact_dir),
            "owner_connection_id": owner_connection_id,
            "resources": submission.resources.model_dump(mode="json"),
            "submission": payload,
        }
        self.store.save_job(job_id, record)
        self.store.enqueue(job_id, submission.priority, created_at)
        self._event(job_id, "queued", {"priority": submission.priority})
        return self.status(job_id, owner_connection_id=owner_connection_id)

    def status(self, job_id: str, *, owner_connection_id: str) -> JobStatus:
        """Return public metadata for a job owned by one connection."""

        return self._public_status(self._owned_job(job_id, owner_connection_id))

    def admin_status(self, job_id: str) -> JobStatus:
        """Return job metadata without applying a browser ownership filter."""

        job = self.store.get_job(job_id)
        if job is None:
            raise KeyError(job_id)
        return self._public_status(job)

    def list_status(self, *, owner_connection_id: str) -> list[JobStatus]:
        """Return one connection's jobs newest first."""

        return [
            self._public_status(job)
            for job in self._sorted_jobs()
            if job.get("owner_connection_id") == owner_connection_id
        ]

    def admin_list_status(self) -> list[JobStatus]:
        """Return every job, including records created before ownership existed."""

        return [self._public_status(job) for job in self._sorted_jobs()]

    def run_once(self) -> bool:
        """Claim and start the highest-priority compatible job, if any."""

        with self._lock:
            if len(self._active) >= self.max_running_jobs:
                return False
            deferred_job_ids: list[str] = []
            try:
                while True:
                    job_id = self.store.claim_next()
                    if job_id is None:
                        return False
                    job = self.store.get_job(job_id)
                    if job is None or job.get("status") != "queued":
                        continue
                    executor = self._select_executor(job["resources"], job=job)
                    if executor is None:
                        deferred_job_ids.append(job_id)
                        continue
                    self._set_status(
                        job_id,
                        "running",
                        started_at=utc_now(),
                        executor=executor.kind,
                        compute_unit=executor.name,
                    )
                    # The running event is emitted before the executor can
                    # invoke any callback: an executor that completes
                    # synchronously inside submit() (or a very fast Local or
                    # Slurm completion) must never leave a stale running event
                    # after its terminal events.
                    self._event(job_id, "running", {"executor": executor.name})
                    try:
                        project_ctx = self._project_execution_context(job)
                        heartbeat = lambda details: self._heartbeat(job_id, details)
                        finished = lambda return_code, details: self._finished(job_id, return_code, details)
                        if project_ctx is None:
                            handle = executor.submit(job, job["artifact_dir"], heartbeat, finished)
                        else:
                            handle = executor.submit(
                                job,
                                job["artifact_dir"],
                                heartbeat,
                                finished,
                                project=project_ctx,
                            )
                    except Exception as exc:
                        self._set_status(job_id, "failed", finished_at=utc_now(), error=str(exc))
                        self._event(job_id, "failed", {"error": str(exc)})
                        return False
                    current = self.store.get_job(job_id) or job
                    if current.get("status") in TERMINAL_STATES:
                        # The executor completed synchronously during
                        # submit(): the terminal transition was already
                        # persisted and its terminal events emitted. Never
                        # write executor details, register active state, or
                        # emit a stale running event on a terminal record.
                        return True
                    current["executor_details"] = handle
                    self.store.save_job(job_id, current)
                    self._active[job_id] = (executor, handle)
                    return True
            finally:
                for deferred_job_id in deferred_job_ids:
                    deferred_job = self.store.get_job(deferred_job_id)
                    if deferred_job is not None and deferred_job.get("status") == "queued":
                        self.store.enqueue(
                            deferred_job_id,
                            int(deferred_job["priority"]),
                            deferred_job["created_at"],
                        )

    def _select_executor(self, resources: dict[str, Any], *, job: dict[str, Any] | None = None) -> Executor | None:
        """Select a compatible executor with a round-robin cursor.

        Project-scoped jobs run only on local executors: a remote/Slurm
        execution must never assume access to a locally resolved project path.
        """

        project_job = bool((job or {}).get("submission", {}).get("project_id"))
        count = len(self.executors)
        for offset in range(count):
            index = (self._round_robin_cursor + offset) % count
            candidate = self.executors[index]
            if project_job and candidate.kind != "local":
                continue
            if candidate.can_run(resources):
                self._round_robin_cursor = (index + 1) % count
                return candidate
        return None

    def _artifact_dir_for(self, job_id: str, project: _ProjectJob | None) -> Path:
        """Return where a job's artifacts live: the legacy root or project runs."""
        if project is None:
            return self.artifact_root / job_id
        return _project_runs_dir(project.root) / job_id

    def _resolve_project_job(self, project_id: str) -> _ProjectJob:
        """Resolve a project id through the injected service before artifacts exist.

        Raises:
            ValueError: The backend has no project service, the project is
                unknown, its environment is not ready, or no local executor is
                configured for project-scoped jobs.
        """
        if self.project_manager is None:
            raise ValueError(
                f"project {project_id} cannot run: this backend has no project service"
            )
        try:
            summary = self.project_manager.get_project(project_id)
        except Exception as exc:
            raise ValueError(f"cannot resolve project {project_id}: {exc}") from exc
        if summary.environment.status != "ready":
            raise ValueError(
                f"project {project_id} environment is {summary.environment.status}; "
                "synchronize the project environment before submitting a training job"
            )
        if not any(executor.kind == "local" for executor in self.executors):
            raise ValueError(
                "project-scoped training jobs require a local executor; none is configured"
            )
        return _ProjectJob(
            project_id=project_id,
            root=Path(summary.root),
            settings=summary.wandb,
        )

    def _project_execution_context(self, job: dict[str, Any]) -> dict[str, Any] | None:
        """Build the non-persisted execution context for a project-scoped job.

        The W&B API key is resolved from the project service at claim time and
        returned only in memory for the child process environment; it is never
        written to the job record, Hydra configs, or logs. Legacy jobs return
        None and keep their exact prior behavior.
        """
        submission = job.get("submission") or {}
        project_id = submission.get("project_id")
        if project_id is None:
            return None
        if self.project_manager is None:
            raise ValueError(
                f"project {project_id} cannot run: this backend has no project service"
            )
        root = Path(self.project_manager.resolve_root(project_id)).resolve()
        api_key = self.project_manager.wandb_api_key(project_id)
        return {
            "project_id": project_id,
            "root": str(root),
            "python": str(project_python(root)),
            "env": _project_child_env(root, api_key),
        }

    def _heartbeat(self, job_id: str, details: dict[str, Any]) -> None:
        job = self.store.get_job(job_id)
        if job is None or job.get("status") in TERMINAL_STATES:
            return
        timestamp = utc_now()
        job["heartbeat_at"] = timestamp
        job["heartbeat"] = details
        wandb_url = _find_wandb_url(job)
        if wandb_url and wandb_url != job.get("wandb_url"):
            job["wandb_url"] = wandb_url
            self.store.save_job(job_id, job)
            self._event(job_id, "wandb_ready", {"wandb_url": wandb_url})
        else:
            self.store.save_job(job_id, job)
        self._event(job_id, "heartbeat", details)

    def _finished(self, job_id: str, return_code: int, details: dict[str, Any]) -> None:
        job = self.store.get_job(job_id)
        if job is None or job.get("status") in TERMINAL_STATES:
            with self._lock:
                self._active.pop(job_id, None)
            return
        wandb_url = _find_wandb_url(job)
        publish_wandb_url = wandb_url is not None and wandb_url != job.get("wandb_url")
        if return_code == 0:
            if publish_wandb_url:
                self._event(job_id, "wandb_ready", {"wandb_url": wandb_url})
            # The wheel is part of the promised output of a successful job:
            # the job is never persisted as ``succeeded`` before the package
            # export committed. A packaging failure (missing/corrupt safe
            # weights, unsupported adapter, exporter exception) transitions
            # the job to terminal ``failed`` through the same atomic failed
            # transition as any other failure, keeping artifacts and logs.
            if self._export_model_package(job_id):
                self._set_status(
                    job_id,
                    "succeeded",
                    finished_at=utc_now(),
                    error=None,
                    wandb_url=wandb_url,
                )
                self._drop_active(job_id)
                self._event(job_id, "succeeded", details)
            else:
                error = self._package_failure_text(job_id)
                self._set_status(
                    job_id,
                    "failed",
                    finished_at=utc_now(),
                    error=error,
                    wandb_url=wandb_url,
                )
                self._drop_active(job_id)
                self._event(job_id, "failed", {"error": error, **details})
        else:
            error = self._failure_text(job, details)
            self._set_status(
                job_id,
                "failed",
                finished_at=utc_now(),
                error=error,
                wandb_url=wandb_url,
            )
            self._drop_active(job_id)
            if publish_wandb_url:
                self._event(job_id, "wandb_ready", {"wandb_url": wandb_url})
            self._event(job_id, "failed", {"error": error, **details})

    def _drop_active(self, job_id: str) -> None:
        """Remove a finished job from the active set.

        Called only after the terminal state was persisted: keeping the entry
        on a store failure leaves the job as a tracked, recoverable ``running``
        state that stop()/cancellation or restart recovery can reconcile.
        """
        with self._lock:
            self._active.pop(job_id, None)

    def _failure_text(self, job: dict[str, Any], details: dict[str, Any]) -> str:
        """Build a compact error while retaining full logs on disk."""

        stderr_path = details.get("stderr")
        if stderr_path and Path(stderr_path).exists():
            content = Path(stderr_path).read_text(encoding="utf-8", errors="replace").strip()
            if content:
                return content[-4000:]
        return f"Training executor failed: {details}"

    def cancel(self, job_id: str, *, owner_connection_id: str) -> JobStatus:
        """Cancel a queued or active job owned by one connection."""

        self._owned_job(job_id, owner_connection_id)
        return self.admin_cancel(job_id)

    def admin_cancel(self, job_id: str) -> JobStatus:
        """Cancel any queued or active job as the backend administrator."""

        job = self.store.get_job(job_id)
        if job is None:
            raise KeyError(job_id)
        if job["status"] == "queued":
            self.store.remove_from_queue(job_id, int(job["priority"]))
            self._set_status(job_id, "cancelled", finished_at=utc_now())
            self._event(job_id, "cancelled", {})
        elif job["status"] == "running":
            with self._lock:
                active = self._active.get(job_id)
            if active:
                active[0].cancel(job_id)
            self._set_status(job_id, "cancelled", finished_at=utc_now())
            self._event(job_id, "cancelled", {})
        return self.admin_status(job_id)

    def logs(self, job_id: str, *, owner_connection_id: str) -> dict[str, str]:
        """Read logs from a job owned by one connection."""

        self._owned_job(job_id, owner_connection_id)
        return self.admin_logs(job_id)

    def admin_logs(self, job_id: str) -> dict[str, str]:
        """Read complete stdout/stderr logs for any job."""

        job = self.store.get_job(job_id)
        if job is None:
            raise KeyError(job_id)
        root = Path(job["artifact_dir"])
        return {
            "stdout": _read_text(root / "stdout.log"),
            "stderr": _read_text(root / "stderr.log"),
        }

    def package_download(self, job_id: str, *, owner_connection_id: str) -> tuple[Path, str, str]:
        """Resolve and verify the owned job's wheel for download.

        The wheel is streamed from a single opened source handle into an
        immutable backend-private snapshot while its SHA-256 is computed, and
        the snapshot digest is compared in constant time against the
        authoritative ``model_package.sha256`` recorded at export time. The
        download response never reopens the original artifact path: it serves
        the verified snapshot bytes, so a wheel replaced or modified after
        verification cannot influence what is transferred. A snapshot whose
        digest differs from the manifest is deleted and never returned.

        Returns:
            The verified snapshot path, the safe download filename, and the
            SHA-256 digest of the snapshot bytes.

        Raises:
            KeyError: The job does not exist or is not owned by the connection.
            FileNotFoundError: The job has no exported wheel or its declared
                wheel path escapes the artifact root.
            PackageIntegrityError: The declared manifest digest is missing or
                malformed, or the snapshot bytes no longer match it.
        """

        job = self._owned_job(job_id, owner_connection_id)
        package = job.get("model_package")
        if not isinstance(package, dict) or not isinstance(package.get("wheel"), str):
            raise FileNotFoundError("Model package is not available")
        root = Path(job["artifact_dir"]).resolve()
        wheel = (root / package["wheel"]).resolve()
        if root not in wheel.parents or not wheel.is_file() or wheel.suffix != ".whl":
            raise FileNotFoundError("Model package is not available")
        declared = package.get("sha256")
        if not isinstance(declared, str) or not PACKAGE_SHA256_HEX.fullmatch(declared):
            raise PackageIntegrityError("Model package integrity cannot be verified")
        snapshot, computed = _create_package_snapshot(
            wheel,
            snapshot_dir=self.package_snapshot_dir,
        )
        if not hmac.compare_digest(computed, declared.lower()):
            _remove_file(snapshot)
            raise PackageIntegrityError("Model package integrity check failed")
        return snapshot, wheel.name, computed

    def tail_logs(
        self,
        job_id: str,
        *,
        owner_connection_id: str,
        stdout_after: int = 0,
        stderr_after: int = 0,
    ) -> dict[str, dict[str, str | int | bool]]:
        """Return the appended bytes for an owned job's stdout and stderr files.

        Offsets are byte positions so a browser can continuously follow a file
        without forcing the server to load the full artifact into memory.
        """

        job = self._owned_job(job_id, owner_connection_id)
        root = Path(job["artifact_dir"])
        return {
            "stdout": _tail_text(root / "stdout.log", stdout_after),
            "stderr": _tail_text(root / "stderr.log", stderr_after),
        }

    def events(
        self,
        job_id: str,
        after: str | None = None,
        *,
        owner_connection_id: str,
    ) -> list[dict[str, Any]]:
        """Return events for a job owned by one connection."""

        self._owned_job(job_id, owner_connection_id)
        return self.admin_events(job_id, after)

    def admin_events(self, job_id: str, after: str | None = None) -> list[dict[str, Any]]:
        """Return events for any job after a stream sequence number."""

        if self.store.get_job(job_id) is None:
            raise KeyError(job_id)
        return self.store.get_events(job_id, after)

    def _owned_job(self, job_id: str, owner_connection_id: str) -> dict[str, Any]:
        """Load a job only when its persisted owner matches exactly."""

        job = self.store.get_job(job_id)
        if job is None or job.get("owner_connection_id") != owner_connection_id:
            raise KeyError(job_id)
        return job

    def _sorted_jobs(self) -> list[dict[str, Any]]:
        return sorted(self.store.list_jobs(), key=lambda item: item["created_at"], reverse=True)

    @staticmethod
    def _public_status(job: dict[str, Any]) -> JobStatus:
        return JobStatus.model_validate({key: job.get(key) for key in JobStatus.model_fields})

    def _set_status(self, job_id: str, status: str, **changes: Any) -> None:
        if status == "failed":
            self._persist_failed(job_id, changes)
            return
        job = self.store.get_job(job_id)
        if job is None:
            return
        job["status"] = status
        job.update(changes)
        self.store.save_job(job_id, job)

    def _persist_failed(self, job_id: str, changes: dict[str, Any]) -> None:
        """Atomically persist the failed transition, retrying transient failures.

        Uses the store's ``mark_failed`` so the record update and the queue
        removal are one atomic operation. A persistence failure is never
        swallowed: after a bounded number of attempts the exception propagates,
        leaving the job in its previous recoverable state rather than a partial
        transition (``failed``+queued or dequeued+``running``).
        """
        for attempt in range(FAILED_TRANSITION_ATTEMPTS):
            try:
                self.store.mark_failed(job_id, changes)
                return
            except Exception:
                if attempt == FAILED_TRANSITION_ATTEMPTS - 1:
                    raise
                time.sleep(FAILED_TRANSITION_BACKOFF_SECONDS)

    def _event(self, job_id: str, event_type: str, details: dict[str, Any]) -> None:
        self.store.append_event(job_id, {"type": event_type, "at": utc_now(), **details})

    def _package_failure_text(self, job_id: str) -> str:
        """Build the client-visible error for a job whose package export failed."""

        job = self.store.get_job(job_id)
        package_error = job.get("package_error") if job is not None else None
        if package_error:
            return f"Model package export failed: {package_error}"
        return "Model package export failed"

    def _export_model_package(self, job_id: str) -> bool:
        """Export the portable wheel for a finished job.

        Returns True when the wheel was built and its manifest persisted.
        On any failure — missing or corrupt safe weights, an unsupported
        input adapter, or an exporter exception — the job record keeps a
        client-visible ``package_error``, the ``package_failed`` event is
        emitted, and False is returned so the caller can transition the job
        to the terminal ``failed`` state. A job without safe weights is a
        packaging failure, never a silent success.
        """

        job = self.store.get_job(job_id)
        if job is None:
            return False
        artifact_dir = Path(job["artifact_dir"])
        package_name = job["submission"].get("package_name") or f"nnm_job_{job_id.replace('-', '')}"
        try:
            build_model_wheel(artifact_dir, package_name=package_name, version="0.1.0")
            manifest_path = artifact_dir / "model-package.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:
            job["package_error"] = str(exc)
            self.store.save_job(job_id, job)
            self._event(job_id, "package_failed", {"error": str(exc)})
            return False
        job["model_package"] = manifest
        job["package_error"] = None
        self.store.save_job(job_id, job)
        self._event(job_id, "package_ready", manifest)
        return True


def _read_text(path: Path) -> str:
    """Read a log file if it exists."""

    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""


def _remove_file(path: Path) -> None:
    """Delete a temporary snapshot, tolerating races and double removal."""

    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _create_package_snapshot(
    source: Path,
    *,
    snapshot_dir: Path | None,
    chunk_size: int = PACKAGE_SNAPSHOT_CHUNK_SIZE,
) -> tuple[Path, str]:
    """Copy a wheel into a private immutable snapshot while hashing it in one pass.

    The source is opened exactly once and the returned digest covers exactly
    the bytes copied into the snapshot, so a concurrent replacement of the
    source path can never produce a verified snapshot whose bytes differ from
    what the download later serves. The snapshot is created with ``0600``
    permissions in the OS temporary directory (or ``snapshot_dir`` when given)
    and is never reachable through any API path.

    Returns:
        The snapshot path and its SHA-256 hex digest.

    Raises:
        FileNotFoundError: If the source disappeared before it could be opened.
    """

    if snapshot_dir is not None:
        snapshot_dir.mkdir(parents=True, exist_ok=True)
    fd, raw_path = tempfile.mkstemp(
        prefix="nnm_pkg_",
        suffix=".whl",
        dir=str(snapshot_dir) if snapshot_dir is not None else None,
    )
    snapshot = Path(raw_path)
    digest = hashlib.sha256()
    try:
        with os.fdopen(fd, "wb") as writer, source.open("rb") as reader:
            while True:
                chunk = reader.read(chunk_size)
                if not chunk:
                    break
                writer.write(chunk)
                digest.update(chunk)
    except BaseException:
        _remove_file(snapshot)
        raise
    return snapshot, digest.hexdigest()


def _tail_text(path: Path, offset: int, *, limit: int = 64 * 1024) -> dict[str, str | int | bool]:
    """Read at most ``limit`` new bytes, restarting when a file was replaced."""

    safe_offset = max(offset, 0)
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        return {"text": "", "offset": safe_offset, "reset": False}
    reset = safe_offset > size
    start = 0 if reset else safe_offset
    with path.open("rb") as stream:
        stream.seek(start)
        chunk = stream.read(limit)
    return {
        "text": chunk.decode("utf-8", errors="replace"),
        "offset": start + len(chunk),
        "reset": reset,
    }


def _find_wandb_url(job: dict[str, Any]) -> str | None:
    """Extract the W&B run URL printed by the known training entry point."""

    root = Path(job["artifact_dir"])
    content = "\n".join(
        _read_text(root / filename) for filename in ("stdout.log", "stderr.log")
    )
    match = re.search(r"https?://wandb\.ai/[A-Za-z0-9._/-]+", content)
    return match.group(0).rstrip(".,)") if match else None


def _merge_wandb_defaults(settings: WandbSettings, job_wandb: dict[str, Any]) -> dict[str, Any]:
    """Merge project W&B defaults under the job's explicit non-secret settings.

    Explicit job fields win; omitted fields inherit the project values. The
    API key is never part of this merge — it lives in the companion secrets
    store and is injected only into the child process environment. The
    project's ``run_name_template`` maps to the run ``name`` because that is
    the WandbLogger keyword carrying a run name.

    Raises:
        ValueError: If ``job_wandb`` is not a JSON object.
    """
    if not isinstance(job_wandb, dict):
        raise ValueError("training.wandb must be a JSON object")
    defaults: dict[str, Any] = {"project": settings.project, "mode": settings.mode}
    if settings.entity:
        defaults["entity"] = settings.entity
    if settings.tags:
        defaults["tags"] = list(settings.tags)
    if settings.run_name_template:
        defaults["name"] = settings.run_name_template
    return {**defaults, **job_wandb}


def _project_runs_dir(root: Path) -> Path:
    """Resolve ``<root>/runs`` while refusing symlink escape outside the root.

    Returns:
        The resolved runs directory, guaranteed to stay below the resolved
        project root.

    Raises:
        ValueError: If the resolved runs path lies outside the resolved root
            (for example a ``runs`` symlink pointing elsewhere).
    """
    resolved_root = root.resolve()
    runs = (resolved_root / "runs").resolve()
    if runs != resolved_root and resolved_root not in runs.parents:
        raise ValueError(
            f"project runs directory {runs} resolves outside the project root; "
            "refusing to store job artifacts there"
        )
    return runs


def _project_child_env(root: Path, api_key: str | None) -> dict[str, str]:
    """Build the complete child environment without mutating the parent.

    Project ``src/`` and ``datasets/`` are prepended to any inherited
    ``PYTHONPATH`` (never clobbered), and the W&B API key is injected only
    when the project stores one.
    """
    env = os.environ.copy()
    parts = [str(root / "src"), str(root / "datasets")]
    inherited = env.get("PYTHONPATH")
    if inherited:
        parts.append(inherited)
    env["PYTHONPATH"] = os.pathsep.join(parts)
    if api_key:
        env["WANDB_API_KEY"] = api_key
    return env
