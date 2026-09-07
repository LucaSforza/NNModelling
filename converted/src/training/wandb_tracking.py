"""Package-worker-only W&B tracking.

The tracker is intentionally independent of the backend API.  It receives a
validated credential object only for an explicitly online run, keeps all SDK
state below the job artifact directory, and writes one structured run manifest
as soon as the SDK run has been created.
"""

from __future__ import annotations

import importlib
import json
import math
import os
import tempfile
from collections.abc import Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from backend.wandb_credentials import WandbCredentials


WANDB_MODES = frozenset({"disabled", "offline", "online"})
DEFAULT_WANDB_PROJECT = "NeuralNetworks"
_WANDB_FIELDS = frozenset({"mode", "project"})


def normalize_wandb_config(value: Any) -> dict[str, str]:
    """Validate and normalize the browser-facing W&B mode/project object."""

    if value is None:
        value = {}
    if not isinstance(value, Mapping):
        raise ValueError("training.wandb must be an object")
    if set(value) - _WANDB_FIELDS:
        raise ValueError("training.wandb accepts only mode and project")
    mode = value.get("mode", "disabled")
    if not isinstance(mode, str) or mode not in WANDB_MODES:
        raise ValueError("training.wandb.mode must be disabled, offline, or online")
    project = value.get("project", DEFAULT_WANDB_PROJECT)
    if not isinstance(project, str) or not project.strip() or len(project) > 255:
        raise ValueError("training.wandb.project must be a non-empty string")
    return {"mode": mode, "project": project}


def run_name_from_request(request: Mapping[str, Any]) -> str:
    """Derive a stable W&B run name from the immutable NNModelling job ID."""

    job_id = request.get("id", request.get("job_id"))
    if not isinstance(job_id, str) or not job_id:
        raise ValueError("a job id is required for W&B tracking")
    return f"nnm-{job_id}"


def _settings(
    sdk: Any,
    *,
    mode: str,
    artifacts_path: Path,
    credentials: WandbCredentials | None = None,
) -> Any | None:
    """Build one explicit settings object for the pinned W&B SDK."""

    settings_class = getattr(sdk, "Settings", None)
    if settings_class is None:
        return None
    settings_values: dict[str, Any] = {
        "mode": mode,
        "root_dir": str(artifacts_path),
        "x_files_dir": str(artifacts_path / "wandb"),
    }
    if credentials is not None:
        settings_values.update({"base_url": credentials.base_url, "api_key": credentials.api_key})
    return settings_class(**settings_values)


@contextmanager
def _temporary_wandb_environment(credentials: WandbCredentials) -> Iterator[None]:
    """Expose selected W&B connection values only for the SDK init call."""

    values = {"WANDB_API_KEY": credentials.api_key, "WANDB_BASE_URL": credentials.base_url}
    previous = {name: os.environ.get(name) for name in values}
    try:
        os.environ.update(values)
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def _set_summary(run: Any, key: str, value: Any) -> None:
    summary = getattr(run, "summary", None)
    if summary is not None:
        summary[key] = value


class WandbTracker:
    """Track one package-worker training run or act as a disabled no-op."""

    def __init__(
        self,
        *,
        mode: str,
        project: str,
        run_name: str,
        artifacts_path: Path,
        config: Mapping[str, Any],
        credentials: WandbCredentials | Mapping[str, Any] | None = None,
        entity: str | None = None,
        sdk: Any | None = None,
    ) -> None:
        normalized = normalize_wandb_config({"mode": mode, "project": project})
        self.mode = normalized["mode"]
        self.project = normalized["project"]
        self.run_name = run_name
        self.artifacts_path = artifacts_path
        self.manifest_path = artifacts_path / "wandb-run.json"
        self._run: Any | None = None
        self._finished = False
        self._sdk = None
        self._entity = entity
        self._credentials: WandbCredentials | None = None
        if credentials is not None:
            self._credentials = (
                credentials
                if isinstance(credentials, WandbCredentials)
                else WandbCredentials.from_mapping(credentials)
            )
        if self.mode == "disabled":
            if self._credentials is not None:
                raise ValueError("disabled W&B tracking must not receive credentials")
            return
        if self.mode == "online":
            if self._credentials is None:
                raise ValueError("online W&B tracking requires worker credentials")
            self._entity = self._credentials.entity
        elif self._credentials is not None:
            raise ValueError("offline W&B tracking must not receive credentials")
        self._validate_config(config)
        self.artifacts_path.mkdir(parents=True, exist_ok=True)
        sdk_module = sdk if sdk is not None else importlib.import_module("wandb")
        self._sdk = sdk_module
        sdk_dir = self.artifacts_path / "wandb"
        sdk_dir.mkdir(parents=True, exist_ok=True)
        init_kwargs: dict[str, Any] = {
            "project": self.project,
            "name": self.run_name,
            "mode": self.mode,
            "dir": str(self.artifacts_path),
            "config": dict(config),
        }
        if self._entity is not None:
            init_kwargs["entity"] = self._entity
        settings = _settings(
            sdk_module,
            mode=self.mode,
            artifacts_path=self.artifacts_path,
            credentials=self._credentials,
        )
        if settings is not None:
            init_kwargs["settings"] = settings
        if self.mode == "online":
            init_kwargs["force"] = True
            assert self._credentials is not None
            with _temporary_wandb_environment(self._credentials):
                self._run = sdk_module.init(**init_kwargs)
        else:
            self._run = sdk_module.init(**init_kwargs)
        if self._run is None:
            raise RuntimeError("W&B SDK did not return a run")
        run_id = getattr(self._run, "id", None)
        self._run_id = run_id if isinstance(run_id, str) and run_id else self.run_name
        self._write_manifest()

    @staticmethod
    def _validate_config(config: Mapping[str, Any]) -> None:
        """Reject accidental secret-bearing config before calling the SDK."""

        forbidden = {"api_key", "key", "credentials", "token", "password"}
        if _contains_forbidden_key(config, forbidden):
            raise ValueError("W&B config contains a forbidden secret field")

    @property
    def run(self) -> Any | None:
        """Return the SDK run for diagnostics and tests."""

        return self._run

    def log_epoch(self, epoch: int, train_loss: float, validation_loss: float) -> None:
        """Record the two package training metrics for one epoch."""

        if self._run is None:
            return
        self._run.log(
            {"train/loss": float(train_loss), "validation/loss": float(validation_loss)},
            step=int(epoch),
        )

    def finish(
        self,
        *,
        best_loss: float | None,
        completed_epochs: int,
        num_parameters: int,
    ) -> None:
        """Publish final metrics, explicitly finish the SDK run, and write its manifest."""

        if self._finished:
            return
        if self._run is None:
            self._finished = True
            return
        normalized_best = best_loss if best_loss is not None and math.isfinite(best_loss) else None
        try:
            _set_summary(self._run, "best_loss", normalized_best)
            _set_summary(self._run, "completed_epochs", int(completed_epochs))
            _set_summary(self._run, "num_parameters", int(num_parameters))
        finally:
            self._run.finish()
            self._finished = True
        self._write_manifest()

    def abort(self) -> None:
        """Finish a failed SDK run without manufacturing a successful manifest."""

        if self._run is not None and not self._finished:
            try:
                self._run.finish(exit_code=1)
            finally:
                self._finished = True

    def _write_manifest(self) -> None:
        run_url = getattr(self._run, "url", None) if self.mode == "online" else None
        if not isinstance(run_url, str) or (
            self._credentials is not None and self._credentials.api_key in run_url
        ):
            run_url = None
        _atomic_write_json(
            self.manifest_path,
            {
                "mode": self.mode,
                "id": self._run_id,
                "entity": self._entity,
                "project": self.project,
                "url": run_url,
            },
        )

    def __enter__(self) -> "WandbTracker":
        return self

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> None:
        if exc_type is not None:
            self.abort()


def _atomic_write_json(path: Path, value: Mapping[str, Any]) -> None:
    """Write a structured manifest without exposing a partially written file."""

    encoded = json.dumps(value, indent=2, sort_keys=True, allow_nan=False).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    descriptor: int | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temporary_path = Path(temporary_name)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(encoded)
            stream.write(b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
        temporary_path = None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def _contains_forbidden_key(value: Any, forbidden: set[str]) -> bool:
    """Find secret-shaped keys in nested configuration data."""

    if isinstance(value, Mapping):
        return any(
            str(key).lower() in forbidden or _contains_forbidden_key(item, forbidden)
            for key, item in value.items()
        )
    if isinstance(value, (list, tuple)):
        return any(_contains_forbidden_key(item, forbidden) for item in value)
    return False


def create_tracker(
    training: Mapping[str, Any],
    request: Mapping[str, Any],
    artifacts_path: Path,
    *,
    credentials: WandbCredentials | Mapping[str, Any] | None = None,
    entity: str | None = None,
    sdk: Any | None = None,
) -> WandbTracker:
    """Create a tracker from normalized training and immutable job data."""

    config = normalize_wandb_config(training.get("wandb"))
    run_name = "nnm-disabled" if config["mode"] == "disabled" else run_name_from_request(request)
    return WandbTracker(
        mode=config["mode"],
        project=config["project"],
        run_name=run_name,
        artifacts_path=artifacts_path,
        config=training,
        credentials=credentials,
        entity=entity,
        sdk=sdk,
    )
