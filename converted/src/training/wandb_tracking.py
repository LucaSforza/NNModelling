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

from PIL import Image, ImageDraw, ImageFont

from backend.wandb_credentials import WandbCredentials


WANDB_MODES = frozenset({"disabled", "offline", "online"})
DEFAULT_WANDB_PROJECT = "NeuralNetworks"
_WANDB_FIELDS = frozenset({"mode", "project"})

CLASSIFICATION_METRICS = (
    "accuracy",
    "precision",
    "recall",
    "f1",
    "specificity",
    "macro_precision",
    "macro_recall",
    "macro_f1",
)
_CLASSIFICATION_REQUIRED = frozenset(CLASSIFICATION_METRICS)


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
def _temporary_wandb_environment(
    artifacts_path: Path,
    *,
    credentials: WandbCredentials | None = None,
) -> Iterator[None]:
    """Confine writable SDK state and optionally expose init credentials."""

    values = {
        "WANDB_CACHE_DIR": str(artifacts_path / "wandb" / "cache"),
        "WANDB_DATA_DIR": str(artifacts_path / "wandb" / "data"),
    }
    if credentials is not None:
        values.update({"WANDB_API_KEY": credentials.api_key, "WANDB_BASE_URL": credentials.base_url})
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


def _classification_metrics(value: Mapping[str, Any], *, binary: bool) -> dict[str, float]:
    """Validate the finite scalar metrics accepted by the tracker API."""

    expected = set(CLASSIFICATION_METRICS)
    if not binary:
        expected = {"accuracy", "macro_precision", "macro_recall", "macro_f1"}
    if set(value) != expected:
        raise ValueError(f"classification metrics must contain exactly {sorted(expected)}")
    result: dict[str, float] = {}
    for key, raw in value.items():
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw):
            raise ValueError(f"classification metric {key!r} must be a finite number")
        result[key] = float(raw)
    return result


def _classification_final(value: Mapping[str, Any]) -> tuple[dict[str, float], list[list[int]], list[int], list[int], list[str], int, bool]:
    """Validate final test metrics and the data needed for a W&B confusion plot."""

    required = {"loss", "count", "labels", "actual", "predicted", "confusion_matrix", "binary"}
    if not required.issubset(value):
        raise ValueError("classification final payload has unexpected or missing fields")
    binary = value["binary"]
    if not isinstance(binary, bool):
        raise ValueError("classification final payload binary must be a boolean")
    expected = required | (_CLASSIFICATION_REQUIRED if binary else {
        "accuracy", "macro_precision", "macro_recall", "macro_f1"
    })
    if set(value) != expected:
        raise ValueError("classification final payload has unexpected or missing fields")
    metrics = _classification_metrics(
        {key: value[key] for key in CLASSIFICATION_METRICS if key in value}, binary=binary
    )
    loss = value["loss"]
    count = value["count"]
    if isinstance(loss, bool) or not isinstance(loss, (int, float)) or not math.isfinite(loss):
        raise ValueError("classification final loss must be a finite number")
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise ValueError("classification final count must be a non-negative integer")
    labels = value["labels"]
    actual = value["actual"]
    predicted = value["predicted"]
    matrix = value["confusion_matrix"]
    if (
        not isinstance(labels, list)
        or not labels
        or any(not isinstance(label, str) or not label for label in labels)
        or not isinstance(actual, list)
        or not isinstance(predicted, list)
        or len(actual) != len(predicted)
        or len(actual) != count
        or any(isinstance(item, bool) or not isinstance(item, int) for item in actual + predicted)
        or not isinstance(matrix, list)
        or len(matrix) != len(labels)
        or any(
            not isinstance(row, list)
            or len(row) != len(labels)
            or any(isinstance(item, bool) or not isinstance(item, int) or item < 0 for item in row)
            for row in matrix
        )
    ):
        raise ValueError("classification final payload has invalid labels, examples, or matrix")
    return metrics, matrix, actual, predicted, labels, count, binary


def _write_confusion_matrix_image(
    path: Path,
    matrix: list[list[int]],
    labels: list[str],
) -> None:
    """Render a portable heatmap instead of relying on W&B's custom chart."""

    classes = len(labels)
    cell_size = max(1, min(160, 960 // classes))
    left = 180
    top = 120
    grid_size = classes * cell_size
    width = max(640, left + grid_size + 40)
    height = max(640, top + grid_size + 40)
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    axis_font = ImageFont.load_default(size=18)
    label_font = ImageFont.load_default(size=max(8, min(16, cell_size // 4)))
    value_font = ImageFont.load_default(size=max(8, min(18, cell_size // 4)))
    maximum = max((value for row in matrix for value in row), default=0)

    draw.text((left + grid_size / 2, 24), "Confusion matrix", fill="#111827", font=axis_font, anchor="ma")
    draw.text((left + grid_size / 2, 64), "Predicted", fill="#374151", font=axis_font, anchor="ma")
    draw.text((60, top + grid_size / 2), "Actual", fill="#374151", font=axis_font, anchor="mm")
    show_text = cell_size >= 18
    for index, label in enumerate(labels):
        if show_text:
            display_label = label if len(label) <= 18 else f"{label[:15]}..."
            center = index * cell_size + cell_size / 2
            draw.text(
                (left + center, top - 12),
                display_label,
                fill="#374151",
                font=label_font,
                anchor="ms",
            )
            draw.text(
                (left - 12, top + center),
                display_label,
                fill="#374151",
                font=label_font,
                anchor="rm",
            )
        for column, value in enumerate(matrix[index]):
            intensity = value / maximum if maximum else 0.0
            color = (
                round(239 - 202 * intensity),
                round(246 - 147 * intensity),
                round(255 - 20 * intensity),
            )
            x0 = left + column * cell_size
            y0 = top + index * cell_size
            draw.rectangle(
                (x0, y0, x0 + cell_size, y0 + cell_size),
                fill=color,
                outline="#d1d5db" if show_text else None,
            )
            if show_text:
                draw.text(
                    (x0 + cell_size / 2, y0 + cell_size / 2),
                    str(value),
                    fill="white" if intensity > 0.55 else "#111827",
                    font=value_font,
                    anchor="mm",
                )

    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")


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
        with _temporary_wandb_environment(
            self.artifacts_path,
            credentials=self._credentials if self.mode == "online" else None,
        ):
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

    def log_epoch(
        self,
        epoch: int,
        train_loss: float,
        validation_loss: float,
        *,
        train_classification: Mapping[str, Any] | None = None,
        validation_classification: Mapping[str, Any] | None = None,
        binary_classification: bool = True,
    ) -> None:
        """Record losses and, when supplied, classification metrics for one epoch."""

        if isinstance(train_loss, bool) or not isinstance(train_loss, (int, float)) or not math.isfinite(train_loss):
            raise ValueError("train_loss must be a finite number")
        if isinstance(validation_loss, bool) or not isinstance(validation_loss, (int, float)) or not math.isfinite(validation_loss):
            raise ValueError("validation_loss must be a finite number")
        train_values = (
            _classification_metrics(train_classification, binary=binary_classification)
            if train_classification is not None
            else None
        )
        validation_values = (
            _classification_metrics(validation_classification, binary=binary_classification)
            if validation_classification is not None
            else None
        )

        if self._run is None:
            return
        values: dict[str, float] = {
            "train/loss": float(train_loss),
            "validation/loss": float(validation_loss),
        }
        if train_values is not None:
            values.update({f"train/{key}": metric for key, metric in train_values.items()})
        if validation_values is not None:
            values.update({f"validation/{key}": metric for key, metric in validation_values.items()})
        with _temporary_wandb_environment(self.artifacts_path):
            self._run.log(
                values,
                step=int(epoch),
            )

    def finish(
        self,
        *,
        best_loss: float | None,
        completed_epochs: int,
        num_parameters: int,
        classification: Mapping[str, Any] | None = None,
        training_seconds: float | None = None,
    ) -> None:
        """Publish final metrics, explicitly finish the SDK run, and write its manifest."""

        if self._finished:
            return
        if self._run is None:
            self._finished = True
            return
        final_values = None
        if classification is not None:
            final_values = _classification_final(classification)
        if training_seconds is not None and (
            isinstance(training_seconds, bool)
            or not isinstance(training_seconds, (int, float))
            or not math.isfinite(training_seconds)
            or training_seconds < 0
        ):
            raise ValueError("training_seconds must be a non-negative finite number")
        normalized_best = best_loss if best_loss is not None and math.isfinite(best_loss) else None
        try:
            _set_summary(self._run, "best_loss", normalized_best)
            _set_summary(self._run, "completed_epochs", int(completed_epochs))
            _set_summary(self._run, "num_parameters", int(num_parameters))
            if final_values is not None:
                metrics, matrix, _actual, _predicted, labels, count, _binary = final_values
                final_log = {f"test/{key}": value for key, value in metrics.items()}
                final_log["test/loss"] = float(classification["loss"])
                final_log["test/examples"] = count
                if training_seconds is not None:
                    final_log["training/seconds"] = float(training_seconds)
                image_class = getattr(self._sdk, "Image", None)
                if image_class is None:
                    raise RuntimeError("W&B SDK does not provide image logging")
                image_path = self.artifacts_path / "wandb" / "confusion-matrix.png"
                _write_confusion_matrix_image(image_path, matrix, labels)
                final_log["test/confusion_matrix"] = image_class(
                    str(image_path),
                    caption="Confusion matrix — rows: actual, columns: predicted",
                )
                for key, value in final_log.items():
                    if key != "test/confusion_matrix":
                        _set_summary(self._run, key, value)
                _set_summary(self._run, "test/confusion_matrix_values", matrix)
                _set_summary(
                    self._run,
                    "confusion_matrix_convention",
                    f"rows=actual, columns=predicted; labels={labels}",
                )
                _set_summary(self._run, "confusion_matrix_labels", labels)
                with _temporary_wandb_environment(self.artifacts_path):
                    self._run.log(final_log, step=int(completed_epochs))
        finally:
            try:
                with _temporary_wandb_environment(self.artifacts_path):
                    self._run.finish()
            finally:
                self._finished = True
        self._write_manifest()

    def abort(self) -> None:
        """Finish a failed SDK run without manufacturing a successful manifest."""

        if self._run is not None and not self._finished:
            try:
                with _temporary_wandb_environment(self.artifacts_path):
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
