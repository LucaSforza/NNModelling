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
from pathlib import Path
from typing import Any

from backend.executors import ContainerExecutor, Executor
from backend.models import JobStatus, JobSubmission, ResourceRequest
from backend.package_store import PackageStore
from backend.store import JobStore, ValkeyJobStore, utc_now
from model_package.exporter import build_model_wheel, repackage_model_wheel, validate_package_name
from model_package.adapters import adapter_spec_from_definition
from dataset.contracts import DatasetReference
from backend.dataset_store import DatasetArchiveStore


TERMINAL_STATES = {"succeeded", "failed", "cancelled"}

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
INTERNAL_PACKAGE_NAME = "nnm_model"


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
        package_store: PackageStore | None = None,
        dataset_store: DatasetArchiveStore | None = None,
    ) -> None:
        self.store = store
        self.artifact_root = Path(artifact_root).resolve()
        self.artifact_root.mkdir(parents=True, exist_ok=True)
        self.executors = executors
        self.max_running_jobs = max_running_jobs
        self.poll_interval = poll_interval
        # Private directory for immutable download snapshots. When unset the
        # OS temporary directory is used (mkstemp files are created ``0600``);
        # the directory is never exposed through any API path.
        self.package_snapshot_dir = (
            Path(package_snapshot_dir) if package_snapshot_dir is not None else None
        )
        self.package_store = package_store or PackageStore(self.artifact_root / "packages")
        self.dataset_store = dataset_store or DatasetArchiveStore(self.artifact_root / "datasets")
        self._active: dict[str, tuple[Executor, dict[str, Any]]] = {}
        self._round_robin_cursor = 0
        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    @classmethod
    def from_environment(cls) -> "JobManager":
        """Build a production manager from backend environment variables."""

        converted_dir = Path(
            os.getenv("NNM_CONVERTED_DIR", Path(__file__).resolve().parents[2])
        ).expanduser().resolve()
        default_artifact_root = converted_dir / "jobs"
        artifact_root = Path(
            os.getenv("NNM_BACKEND_ARTIFACT_ROOT", str(default_artifact_root))
        ).expanduser().resolve()
        package_store = PackageStore(os.getenv("NNM_BACKEND_PACKAGE_ROOT", str(artifact_root / "packages")))
        store = ValkeyJobStore(os.getenv("NNM_VALKEY_URL", "valkey://127.0.0.1:6379/0"))
        executors: list[Executor] = []
        container_image = os.getenv("NNM_CONTAINER_IMAGE")
        if container_image:
            executors.append(
                ContainerExecutor(
                    engine=os.getenv("NNM_CONTAINER_ENGINE", "podman"),
                    image=container_image,
                )
            )
        return cls(store, artifact_root, executors, package_store=package_store)

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
        """Validate, materialize and enqueue a complete job document."""

        if not self.executors:
            raise ValueError(
                "No container executor is configured; package jobs cannot be submitted"
            )
        job_id = str(uuid.uuid4())
        created_at = utc_now()
        # Resolve and validate the immutable bundle before creating any job
        # directory.  In particular, validation must never load or execute
        # package Python in the FastAPI process.
        package_value = dict(submission.network.value)
        bundle_ref = package_value["bundle_ref"]
        stored = self.package_store.get_bundle(bundle_ref, owner_connection_id=owner_connection_id)
        package_value = stored["bundle"]
        if package_value.get("graph") != submission.network.value.get("graph"):
            raise ValueError("package graph does not match the uploaded bundle")
        artifact_dir = self.artifact_root / job_id
        artifact_dir.mkdir(parents=True, exist_ok=False)
        dataset_dir: Path | None = None
        dataset_reference = submission.training.dataset.reference
        if dataset_reference.kind == "project":
            submission.training.dataset.parameters = self.dataset_store.validate_parameters(
                dataset_reference,
                submission.training.dataset.parameters,
                owner_connection_id=owner_connection_id,
            )
            dataset_dir = artifact_dir / "dataset"
            self.dataset_store.extract(
                dataset_reference,
                owner_connection_id=owner_connection_id,
                destination=dataset_dir,
            )
        payload = submission.model_dump(mode="json")
        payload["id"] = job_id
        payload["created_at"] = created_at
        payload["artifact_dir"] = str(artifact_dir)
        requested_path = artifact_dir / "requested_config.json"
        requested_path.write_text(json.dumps(submission.model_dump(mode="json"), indent=2), encoding="utf-8")
        (artifact_dir / "package.json").write_text(
            json.dumps(package_value, sort_keys=True), encoding="utf-8"
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
            "dataset": submission.training.dataset.model_dump(mode="json"),
            "dataset_dir": str(dataset_dir) if dataset_dir is not None else None,
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
                    executor = self._select_executor(job["resources"], job)
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
                        handle = executor.submit(
                            job,
                            job["artifact_dir"],
                            lambda details: self._heartbeat(job_id, details),
                            lambda return_code, details: self._finished(job_id, return_code, details),
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

    def _select_executor(self, resources: dict[str, Any], job: dict[str, Any] | None = None) -> Executor | None:
        """Select a compatible executor with a round-robin cursor."""

        is_package_job = bool(
            job and job.get("submission", {}).get("network", {}).get("format") == "package"
        )
        count = len(self.executors)
        for offset in range(count):
            index = (self._round_robin_cursor + offset) % count
            candidate = self.executors[index]
            if is_package_job and candidate.kind != "container":
                continue
            if not is_package_job and candidate.kind == "container":
                continue
            if candidate.can_run(resources):
                self._round_robin_cursor = (index + 1) % count
                return candidate
        return None

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

    def package_download(
        self,
        job_id: str,
        *,
        package_name: str,
        owner_connection_id: str,
    ) -> tuple[Path, str, str]:
        """Rebuild and verify an owned job's wheel for download.

        ``package_name`` is the only user-selected package identity. The
        server-generated template wheel is verified before it is repackaged,
        and the newly generated wheel is then copied into an immutable
        download snapshot whose digest is returned to the API layer.

        Returns:
            The verified snapshot path, the safe download filename, and the
            SHA-256 digest of the generated snapshot bytes.

        Raises:
            KeyError: The job does not exist or is not owned by the connection.
            FileNotFoundError: The job has no exported wheel or its declared
                wheel path escapes the artifact root.
            PackageIntegrityError: The declared template digest is missing or
                malformed, or the generated snapshot cannot be verified.
        """

        validate_package_name(package_name)
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
        template_snapshot, computed = _create_package_snapshot(
            wheel,
            snapshot_dir=self.package_snapshot_dir,
        )
        if not hmac.compare_digest(computed, declared.lower()):
            _remove_file(template_snapshot)
            raise PackageIntegrityError("Model package integrity check failed")
        _remove_file(template_snapshot)

        with tempfile.TemporaryDirectory(prefix="nnm-download-") as temporary:
            generated = repackage_model_wheel(
                wheel,
                temporary,
                package_name=package_name,
            )
            snapshot, generated_digest = _create_package_snapshot(
                generated,
                snapshot_dir=self.package_snapshot_dir,
            )
        return snapshot, generated.name, generated_digest

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
        try:
            package = json.loads((artifact_dir / "package.json").read_text(encoding="utf-8"))
            dataset = DatasetReference.model_validate(job["submission"]["training"]["dataset"]["reference"])
            definition = self.dataset_store.metadata(
                dataset,
                owner_connection_id=job["owner_connection_id"],
            )["definition"]
            if isinstance(definition, dict):
                input_adapter = adapter_spec_from_definition(definition)
            else:
                input_adapter = adapter_spec_from_definition(definition.model_dump(mode="json"))
            build_model_wheel(
                artifact_dir,
                package_name=INTERNAL_PACKAGE_NAME,
                version="0.1.0",
                package=package,
                input_adapter=input_adapter,
            )
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
    suffix: str = ".whl",
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
        suffix=suffix,
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
