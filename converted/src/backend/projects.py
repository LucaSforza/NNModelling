"""Companion project lifecycle: registry, safety, graph, W&B, and catalogs.

The project manager owns the companion state directory (recent-project
registry plus owner-only secrets), scaffolds and validates project roots, and
drives ``uv`` environment synchronization. Safety invariants:

- Project IDs resolve only through the companion-owned registry; a client
  can never address an arbitrary filesystem path.
- Client-supplied relative file paths are joined against the resolved root
  and rejected when they escape it (``..``, absolute paths, or symlinks).
- Registry, secrets, metadata, and graph writes are atomic (write-temp +
  ``os.replace``); the secrets file is written with owner-only permissions.
- A failed open, create, or graph write never changes the active project or
  the previously persisted graph.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import threading
import tomllib
from pathlib import Path
from typing import Any

from backend.dataset_registry import discover_datasets, discover_project_datasets
from backend.project_env import EnvironmentSyncError, find_uv, project_python, sync_project_environment
from backend.project_schema import (
    DatasetCatalogError,
    DatasetCatalogResponse,
    EnvironmentState,
    PROJECT_SCHEMA_VERSION,
    ProjectMetadata,
    ProjectSummary,
    RecentProjectsResponse,
    StereotypeCatalogResponse,
    WandbSettings,
    WandbUpdate,
)
from backend.stereotype_registry import build_project_catalog
from backend.store import utc_now

STATE_VERSION = 1
SECRETS_VERSION = 1
PROJECT_ID_LENGTH = 16
WANDB_KEY_MAX_LENGTH = 200
NAME_MAX_LENGTH = 80
_NAME_FORBIDDEN = re.compile(r"[/\\\x00-\x1f]")
SCAFFOLD_DIRS = ("model", "stereotypes", "src", "assets", "datasets", "runs")
NNMODELLING_PACKAGE = "mnist-fds"


class ProjectError(Exception):
    """Project lifecycle error with a stable machine-readable code.

    Attributes:
        code: Stable identifier used by the API layer to map to HTTP statuses.
    """

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def default_state_dir() -> Path:
    """Return the platform user-data location for companion state.

    Overridable through ``NNM_STATE_DIR`` for tests and deployment.
    """
    override = os.getenv("NNM_STATE_DIR")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        base = Path(os.getenv("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.getenv("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    return base / "nnmodelling"


class ProjectManager:
    """Lifecycle, persistence, and catalog operations for project workspaces."""

    def __init__(
        self,
        state_dir: str | Path,
        *,
        converted_dir: str | Path | None = None,
        uv_bin: str | None = None,
        sync_timeout: float = 600.0,
        sync_enabled: bool = True,
    ) -> None:
        self.state_dir = Path(state_dir)
        self.converted_dir = Path(converted_dir or os.getenv("NNM_CONVERTED_DIR") or _default_converted_dir())
        self.uv_bin = uv_bin if uv_bin is not None else find_uv()
        self.sync_timeout = sync_timeout
        self.sync_enabled = sync_enabled
        self._lock = threading.RLock()
        self._loaded = False
        self._active: str | None = None
        self._projects: dict[str, dict[str, Any]] = {}
        self._secrets_loaded = False
        self._secrets_data: dict[str, str] = {}

    @classmethod
    def from_environment(cls) -> "ProjectManager":
        """Build a production manager from backend environment variables."""
        return cls(state_dir=default_state_dir())

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def create_project(self, name: str | None, root_raw: str, *, sync: bool = True) -> ProjectSummary:
        """Scaffold a new project and record it as active and recent.

        Raises:
            ProjectError: The root is not a directory, is a non-empty
                incompatible directory (never overwritten), or already holds
                a valid project (use ``open_project``).
        """
        root = _normalize_root(root_raw)
        if root.exists() and not root.is_dir():
            raise ProjectError("invalid_root", f"{root} is not a directory")
        if root.exists() and any(root.iterdir()):
            if (root / "nnmodelling.toml").is_file():
                raise ProjectError(
                    "project_exists",
                    f"a project already exists at {root}; open it instead of creating it",
                )
            raise ProjectError(
                "incompatible_root",
                f"{root} is not empty and does not contain a valid NNModelling "
                "project; refusing to overwrite it",
            )
        final_name = name or root.name
        _validate_name(final_name)
        root.mkdir(parents=True, exist_ok=True)
        try:
            self._scaffold(root, final_name)
        except Exception as exc:  # noqa: BLE001 - surfaced as an actionable failure
            raise ProjectError(
                "scaffold_failed",
                f"cannot scaffold project at {root}: {exc}",
            ) from exc
        record = self._register(root, final_name, last_opened=utc_now())
        self._set_active(record["id"])
        if sync and self.sync_enabled:
            self._sync_record(record)
        return self.get_project(record["id"])

    def open_project(self, root_raw: str, *, sync: bool = True) -> ProjectSummary:
        """Validate and record an existing project as active and recent.

        On failure the previously active project and persisted graph are left
        unchanged: metadata validation happens before any registry write.
        """
        root = _normalize_root(root_raw)
        if not root.is_dir():
            raise ProjectError(
                "project_not_found",
                f"project root {root} does not exist or is not a directory",
            )
        metadata = self._read_metadata(root)
        record = self._register(root, metadata.name, last_opened=utc_now())
        self._set_active(record["id"])
        if sync and self.sync_enabled:
            self._sync_record(record)
        return self.get_project(record["id"])

    def list_projects(self) -> RecentProjectsResponse:
        """Return recent projects newest-first plus the active project."""
        records = sorted(
            self._state()["projects"].values(),
            key=lambda record: record.get("last_opened") or "",
            reverse=True,
        )
        return RecentProjectsResponse(
            active=self.active_project(),
            projects=[self._summary(record) for record in records],
        )

    def active_project(self) -> ProjectSummary | None:
        """Return the recorded active project, if any."""
        active_id = self._state()["active"]
        if active_id is None:
            return None
        record = self._state()["projects"].get(active_id)
        if record is None:
            return None
        return self._summary(record)

    def get_project(self, project_id: str) -> ProjectSummary:
        """Return the public summary for one registered project."""
        return self._summary(self._record(project_id))

    def sync_project(self, project_id: str) -> ProjectSummary:
        """Re-run the companion-driven uv sync and return the fresh state."""
        record = self._record(project_id)
        self._sync_record(record)
        return self._summary(record)

    def forget_project(self, project_id: str) -> None:
        """Remove a project from the registry without touching its files."""
        with self._lock:
            self._state()
            if self._projects.pop(project_id, None) is None:
                raise ProjectError("unknown_project", f"unknown project {project_id}")
            if self._active == project_id:
                remaining = sorted(
                    self._projects.values(),
                    key=lambda record: record.get("last_opened") or "",
                    reverse=True,
                )
                self._active = remaining[0]["id"] if remaining else None
            self._persist_state_locked()
        secrets = self._secrets()
        if project_id in secrets:
            del secrets[project_id]
            self._persist_secrets(secrets)

    # ------------------------------------------------------------------
    # Graph persistence
    # ------------------------------------------------------------------

    def read_graph(self, project_id: str) -> dict[str, Any]:
        """Read and parse the active project graph file."""
        record = self._record(project_id)
        root = Path(record["root"])
        metadata = self._read_metadata(root)
        path = _safe_join(root, metadata.model)
        if not path.is_file():
            raise ProjectError(
                "graph_missing",
                f"graph file {metadata.model} is missing from the project",
            )
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ProjectError(
                "graph_invalid",
                f"graph file {metadata.model} is not valid JSON: {exc}",
            ) from None
        except OSError as exc:
            raise ProjectError(
                "graph_unreadable",
                f"cannot read graph file {metadata.model}: {exc}",
            ) from None
        return data

    def write_graph(self, project_id: str, graph: dict[str, Any]) -> None:
        """Atomically persist the graph; the previous file survives failures."""
        record = self._record(project_id)
        root = Path(record["root"])
        metadata = self._read_metadata(root)
        path = _safe_join(root, metadata.model)
        path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write_text(path, json.dumps(graph, indent=2) + "\n")

    # ------------------------------------------------------------------
    # W&B configuration and secrets
    # ------------------------------------------------------------------

    def read_wandb(self, project_id: str) -> tuple[WandbSettings, bool]:
        """Return the project's W&B settings and whether a key is stored."""
        record = self._record(project_id)
        metadata = self._read_metadata(Path(record["root"]))
        return metadata.wandb, self.wandb_key_configured(project_id)

    def update_wandb(self, project_id: str, changes: WandbUpdate) -> WandbSettings:
        """Merge non-secret W&B fields into ``nnmodelling.toml``."""
        record = self._record(project_id)
        root = Path(record["root"])
        metadata = self._read_metadata(root)
        current = metadata.wandb.model_dump()
        merged = {
            key: value
            for key, value in changes.model_dump(exclude_unset=True).items()
            if value is not None
        }
        metadata.wandb = WandbSettings.model_validate({**current, **merged})
        _atomic_write_text(root / "nnmodelling.toml", _render_metadata(metadata))
        return metadata.wandb

    def wandb_key_configured(self, project_id: str) -> bool:
        """Return whether a W&B API key is stored for the project."""
        return project_id in self._secrets()

    def set_wandb_key(self, project_id: str, api_key: str) -> None:
        """Store the W&B API key in the owner-only companion secrets file.

        The key is never written into project files, API responses, logs, or
        exports; only ``wandb_key_configured`` is ever observable through the
        project APIs.
        """
        self._record(project_id)
        if not api_key or len(api_key) > WANDB_KEY_MAX_LENGTH:
            raise ProjectError(
                "invalid_secret",
                f"W&B API key must be a non-empty string of at most {WANDB_KEY_MAX_LENGTH} characters",
            )
        secrets = self._secrets()
        secrets[project_id] = api_key
        self._persist_secrets(secrets)

    def delete_wandb_key(self, project_id: str) -> None:
        """Remove the stored W&B API key for the project."""
        self._record(project_id)
        secrets = self._secrets()
        if secrets.pop(project_id, None) is not None:
            self._persist_secrets(secrets)

    def wandb_api_key(self, project_id: str) -> str | None:
        """Resolve the stored W&B API key for a job's child process.

        Intended for the job manager, which injects the key only into the
        subprocess environment. The value is never exposed through any API
        response or log.
        """
        self._record(project_id)
        return self._secrets().get(project_id)

    # ------------------------------------------------------------------
    # Runtime catalogs
    # ------------------------------------------------------------------

    def project_stereotypes(self, project_id: str) -> StereotypeCatalogResponse:
        """Return built-in plus validated project stereotypes."""
        record = self._record(project_id)
        return build_project_catalog(Path(record["root"]))

    def project_datasets(self, project_id: str) -> DatasetCatalogResponse:
        """Return installed plus validated project dataset classes."""
        record = self._record(project_id)
        root = Path(record["root"])
        builtin = discover_datasets()
        discovery = discover_project_datasets(root)
        return DatasetCatalogResponse(
            datasets=[*builtin, *discovery.datasets],
            errors=[
                DatasetCatalogError(path=item["path"], error=item["error"])
                for item in discovery.errors
            ],
        )

    def resolve_root(self, project_id: str) -> Path:
        """Resolve a registered project's root for job execution."""
        return Path(self._record(project_id)["root"])

    # ------------------------------------------------------------------
    # Internal: registry, secrets, metadata, environment
    # ------------------------------------------------------------------

    def _record(self, project_id: str) -> dict[str, Any]:
        """Load one registry record, raising for unknown projects."""
        record = self._state()["projects"].get(project_id)
        if record is None:
            raise ProjectError("unknown_project", f"unknown project {project_id}")
        return record

    def _register(self, root: Path, name: str, *, last_opened: str) -> dict[str, Any]:
        """Upsert the normalized root in the registry (deduplicated by ID)."""
        project_id = _project_id(root)
        with self._lock:
            self._state()
            existing = self._projects.get(project_id)
            record = {
                "id": project_id,
                "root": str(root),
                "name": name,
                "last_opened": last_opened,
                "synced_at": existing.get("synced_at") if existing else None,
                "sync_error": existing.get("sync_error") if existing else None,
            }
            self._projects[project_id] = record
            self._persist_state_locked()
            return dict(record)

    def _set_active(self, project_id: str) -> None:
        with self._lock:
            self._state()
            self._active = project_id
            self._persist_state_locked()

    def _sync_record(self, record: dict[str, Any]) -> None:
        """Run the environment sync and persist its observable outcome."""
        root = Path(record["root"])
        try:
            state = sync_project_environment(
                root,
                uv_bin=self.uv_bin,
                timeout=self.sync_timeout,
            )
        except EnvironmentSyncError as exc:
            record["sync_error"] = str(exc)
            record["synced_at"] = utc_now()
            self._update_record(record)
            return
        record["sync_error"] = None
        record["synced_at"] = state.synced_at or utc_now()
        self._update_record(record)

    def _update_record(self, record: dict[str, Any]) -> None:
        with self._lock:
            self._state()
            self._projects[record["id"]] = dict(record)
            self._persist_state_locked()

    def _summary(self, record: dict[str, Any]) -> ProjectSummary:
        root = Path(record["root"])
        exists = root.is_dir()
        metadata: ProjectMetadata | None = None
        metadata_valid = True
        metadata_error: str | None = None
        if exists:
            try:
                metadata = self._read_metadata(root)
            except ProjectError as exc:
                metadata_valid = False
                metadata_error = str(exc)
        name = metadata.name if metadata is not None else record.get("name") or root.name
        model = metadata.model if metadata is not None else "model/graph.json"
        wandb = metadata.wandb if metadata is not None else WandbSettings()
        return ProjectSummary(
            id=record["id"],
            name=name,
            root=str(root),
            model=model,
            environment=self._environment_state(record),
            wandb=wandb,
            api_key_configured=self.wandb_key_configured(record["id"]),
            last_opened=record.get("last_opened") or "",
            exists=exists,
            metadata_valid=metadata_valid,
            metadata_error=metadata_error,
        )

    def _environment_state(self, record: dict[str, Any]) -> EnvironmentState:
        python = project_python(record["root"])
        sync_error = record.get("sync_error")
        synced_at = record.get("synced_at")
        if sync_error:
            return EnvironmentState(
                status="error",
                python=str(python),
                message=str(sync_error),
                synced_at=synced_at,
            )
        if python.is_file():
            return EnvironmentState(status="ready", python=str(python), synced_at=synced_at)
        return EnvironmentState(status="missing", python=str(python), synced_at=synced_at)

    def _read_metadata(self, root: Path) -> ProjectMetadata:
        """Read and validate ``nnmodelling.toml`` with actionable errors."""
        path = root / "nnmodelling.toml"
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            raise ProjectError(
                "metadata_missing",
                f"project metadata file {path.name} is missing from {root}",
            ) from None
        except OSError as exc:
            raise ProjectError(
                "metadata_unreadable",
                f"cannot read project metadata {path.name}: {exc}",
            ) from None
        try:
            data = tomllib.loads(raw)
        except tomllib.TOMLDecodeError as exc:
            raise ProjectError(
                "metadata_invalid",
                f"invalid TOML in {path.name}: {exc}",
            ) from None
        try:
            metadata = ProjectMetadata.model_validate(data)
        except Exception as exc:  # noqa: BLE001 - pydantic validation surfaced as-is
            raise ProjectError(
                "metadata_invalid",
                f"invalid project metadata in {path.name}: {exc}",
            ) from exc
        if metadata.schema_version != PROJECT_SCHEMA_VERSION:
            raise ProjectError(
                "metadata_unsupported",
                f"unsupported project schema version {metadata.schema_version} in {path.name}",
            )
        # The declared model path must never escape the root.
        _safe_join(root, metadata.model)
        return metadata

    def _scaffold(self, root: Path, name: str) -> None:
        """Create the complete project layout without overwriting files."""
        for subdir in SCAFFOLD_DIRS:
            (root / subdir).mkdir(parents=True, exist_ok=True)
        _atomic_write_text(root / "nnmodelling.toml", _render_metadata(ProjectMetadata(name=name)))
        _atomic_write_text(root / "pyproject.toml", self._render_pyproject(name, root))
        _atomic_write_text(
            root / "model" / "graph.json",
            json.dumps({"nodes": [], "edges": []}, indent=2) + "\n",
        )

    def _render_pyproject(self, name: str, root: Path) -> str:
        """Render a minimal uv project depending on the NNModelling package.

        ``uv sync --project <root>`` installs the NNModelling package (torch,
        Lightning, Hydra, and friends) into ``<root>/.venv`` so project-local
        training runs with the project interpreter and its own import roots.
        ``requires-python`` is pinned to the companion's own minor version so
        uv selects an interpreter with published wheels for the resolved
        torch build instead of silently picking the newest system Python.
        """
        requires_python = f"=={sys.version_info.major}.{sys.version_info.minor}.*"
        slug = _slug(name) or "project"
        return (
            "[project]\n"
            f'name = "nnm-{slug}"\n'
            'version = "0.1.0"\n'
            'description = "NNModelling project workspace"\n'
            f"requires-python = {json.dumps(requires_python)}\n"
            f'dependencies = ["{NNMODELLING_PACKAGE}"]\n'
            "\n"
            "[tool.uv.sources]\n"
            f'{NNMODELLING_PACKAGE} = {{ path = "{self.converted_dir}" }}\n'
        )

    # ------------------------------------------------------------------
    # Internal: state file persistence
    # ------------------------------------------------------------------

    def _state(self) -> dict[str, Any]:
        with self._lock:
            if not self._loaded:
                self._load_state()
            return {"active": self._active, "projects": self._projects}

    def _load_state(self) -> None:
        path = self.state_dir / "projects.json"
        try:
            raw = path.read_text(encoding="utf-8") if path.is_file() else ""
        except OSError as exc:
            raise ProjectError(
                "state_unreadable",
                f"cannot read companion state {path}: {exc}",
            ) from None
        if not raw:
            self._projects = {}
            self._active = None
            self._loaded = True
            return
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ProjectError(
                "state_corrupt",
                f"companion state file {path.name} is corrupt: {exc}; fix or remove it and retry",
            ) from None
        version = data.get("version", STATE_VERSION)
        if version != STATE_VERSION:
            raise ProjectError(
                "state_unsupported",
                f"unsupported companion state version {version} in {path.name}",
            )
        projects = data.get("projects")
        active = data.get("active")
        if not isinstance(projects, dict) or (active is not None and not isinstance(active, str)):
            raise ProjectError(
                "state_corrupt",
                f"companion state file {path.name} has an invalid structure",
            )
        cleaned: dict[str, dict[str, Any]] = {}
        for project_id, entry in projects.items():
            if not isinstance(entry, dict) or not isinstance(entry.get("root"), str):
                continue
            cleaned[project_id] = {
                "id": project_id,
                "root": entry["root"],
                "name": entry.get("name") or Path(entry["root"]).name,
                "last_opened": entry.get("last_opened") or "",
                "synced_at": entry.get("synced_at"),
                "sync_error": entry.get("sync_error"),
            }
        self._projects = cleaned
        self._active = active if active in cleaned else None
        self._loaded = True

    def _persist_state(self) -> None:
        with self._lock:
            self._persist_state_locked()

    def _persist_state_locked(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": STATE_VERSION,
            "active": self._active,
            "projects": self._projects,
        }
        _atomic_write_text(
            self.state_dir / "projects.json",
            json.dumps(payload, indent=2) + "\n",
        )

    def _secrets(self) -> dict[str, str]:
        with self._lock:
            if not self._secrets_loaded:
                self._load_secrets()
            return self._secrets_data

    def _load_secrets(self) -> None:
        path = self.state_dir / "secrets.json"
        try:
            raw = path.read_text(encoding="utf-8") if path.is_file() else ""
        except OSError as exc:
            raise ProjectError(
                "secrets_unreadable",
                f"cannot read companion secrets {path}: {exc}",
            ) from None
        if not raw:
            self._secrets_data = {}
            self._secrets_loaded = True
            return
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ProjectError(
                "secrets_corrupt",
                f"companion secrets file {path.name} is corrupt: {exc}; fix or remove it and retry",
            ) from None
        version = data.get("version", SECRETS_VERSION)
        if version != SECRETS_VERSION:
            raise ProjectError(
                "secrets_unsupported",
                f"unsupported companion secrets version {version} in {path.name}",
            )
        secrets = data.get("secrets")
        if not isinstance(secrets, dict):
            raise ProjectError(
                "secrets_corrupt",
                f"companion secrets file {path.name} has an invalid structure",
            )
        self._secrets_data = {
            key: value
            for key, value in secrets.items()
            if isinstance(key, str) and isinstance(value, str)
        }
        self._secrets_loaded = True

    def _persist_secrets(self, secrets: dict[str, str]) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        payload = {"version": SECRETS_VERSION, "secrets": secrets}
        _atomic_write_text(
            self.state_dir / "secrets.json",
            json.dumps(payload, indent=2) + "\n",
            mode=0o600,
        )


def _default_converted_dir() -> Path:
    """Locate the repository's converted directory next to this package."""
    return Path(__file__).resolve().parents[2]


def _project_id(root: Path) -> str:
    """Derive a stable, registry-only project ID from the normalized root."""
    return hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:PROJECT_ID_LENGTH]


def _normalize_root(raw: str) -> Path:
    """Expand, resolve, and require an absolute normalized project root."""
    if not isinstance(raw, str) or not raw.strip():
        raise ProjectError("invalid_root", "project root must be a non-empty path")
    try:
        return Path(raw).expanduser().resolve()
    except OSError as exc:
        raise ProjectError(
            "invalid_root",
            f"cannot resolve project root {raw!r}: {exc}",
        ) from None


def _validate_name(name: str) -> None:
    """Validate a project name supplied at creation time."""
    if not name or len(name) > NAME_MAX_LENGTH or _NAME_FORBIDDEN.search(name):
        raise ProjectError(
            "invalid_name",
            f"project name must be 1-{NAME_MAX_LENGTH} characters without slashes or control characters",
        )


def _safe_join(root: Path, relative: str) -> Path:
    """Join a client-supplied relative path without escaping the root.

    Absolute paths, drive-qualified paths, and paths whose resolved target
    lies outside the resolved root (``..`` traversal or symlink escape) are
    rejected.
    """
    if (
        not isinstance(relative, str)
        or not relative
        or relative.startswith(("/", "\\"))
        or ":" in relative
    ):
        raise ProjectError(
            "path_escape",
            "project file paths must be relative to the project root",
        )
    resolved_root = root.resolve()
    candidate = (resolved_root / relative).resolve()
    if candidate != resolved_root and resolved_root not in candidate.parents:
        raise ProjectError(
            "path_escape",
            f"project file path {relative!r} escapes the project root",
        )
    return candidate


def _render_metadata(metadata: ProjectMetadata) -> str:
    """Render project metadata as TOML with stable field ordering.

    JSON string/list literals are valid TOML basic strings for the field
    domains used here, so no third-party TOML writer is required.
    """
    lines = [
        f"schema_version = {PROJECT_SCHEMA_VERSION}",
        f"name = {json.dumps(metadata.name)}",
        f"model = {json.dumps(metadata.model)}",
        "",
        "[wandb]",
        f"entity = {json.dumps(metadata.wandb.entity)}",
        f"project = {json.dumps(metadata.wandb.project)}",
        f"tags = {json.dumps(metadata.wandb.tags)}",
        f"run_name_template = {json.dumps(metadata.wandb.run_name_template)}",
        f"mode = {json.dumps(metadata.wandb.mode)}",
    ]
    return "\n".join(lines) + "\n"


def _slug(name: str) -> str:
    """Build a PEP 508-safe package slug from a project name."""
    slug = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-")
    return re.sub(r"-{2,}", "-", slug)[:40].lower()


def _atomic_write_text(path: Path, content: str, *, mode: int | None = None) -> None:
    """Atomically write text via a same-directory temp file and ``os.replace``.

    The optional ``mode`` (used for the owner-only secrets file) is applied to
    the temporary file before the replace so the final file never inherits a
    broader umask-derived mode.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_path = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    tmp = Path(raw_path)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
