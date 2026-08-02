"""Tests for the companion project workspace lifecycle and catalogs (S1).

The project manager owns the companion state directory (recent registry plus
owner-only secrets), scaffolds and validates project roots, persists graphs
atomically, drives ``uv`` environment synchronization, and serves runtime
stereotype/dataset catalogs. All tests isolate the state directory and project
roots in temporary directories, mock the ``uv`` subprocess, and never touch
the network or the developer's real home directory.
"""

from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

from backend.app import create_app
from backend.auth import AuthService, InMemoryAuthStore
from backend.dataset_registry import discover_datasets, discover_project_datasets
from backend.manager import JobManager
from backend.models import JobSubmission
from backend.project_env import EnvironmentSyncError, project_python
from backend.projects import (
    PROJECT_SCHEMA_VERSION,
    ProjectError,
    ProjectManager,
    _project_id,
    default_state_dir,
)
from backend.store import InMemoryJobStore

OWNER = "project-connection"


class NoopExecutor:
    """Executor double that never accepts a job (project tests need no runs)."""

    name = "noop"
    kind = "local"

    def can_run(self, resources: dict[str, Any]) -> bool:
        return False

    def describe(self) -> dict[str, Any]:
        return {"id": self.name, "kind": self.kind, "capacity": {}, "enabled": True}

    def submit(self, job, artifact_dir, on_heartbeat, on_finished):
        del job, artifact_dir, on_heartbeat, on_finished
        raise AssertionError("noop executor must never run a job")

    def cancel(self, job_id: str) -> bool:
        del job_id
        return True


@pytest.fixture()
def manager(tmp_path: Path) -> ProjectManager:
    """A project manager with an isolated state dir and uv sync disabled."""
    return ProjectManager(tmp_path / "state", sync_enabled=False)


@pytest.fixture()
def project_manager_factory(tmp_path: Path):
    """Factory for managers sharing the same state dir (restart simulation)."""

    state_dir = tmp_path / "state"

    def build(**kwargs: Any) -> ProjectManager:
        return ProjectManager(state_dir, sync_enabled=False, **kwargs)

    return build


def _scaffold_valid_metadata(root: Path, *, name: str = "proj", model: str = "model/graph.json") -> None:
    """Write a valid ``nnmodelling.toml`` into an existing directory."""
    (root / "model").mkdir(parents=True, exist_ok=True)
    (root / "model" / "graph.json").write_text(json.dumps({"nodes": [], "edges": []}), encoding="utf-8")
    (root / "nnmodelling.toml").write_text(
        f'schema_version = {PROJECT_SCHEMA_VERSION}\nname = "{name}"\nmodel = "{model}"\n',
        encoding="utf-8",
    )


class FakeCompleted:
    """Result double for the mocked uv subprocess."""

    def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _patch_uv_success(monkeypatch, root: Path) -> Path:
    """Mock ``uv sync`` to succeed and materialize the project interpreter."""
    python = project_python(root)
    captured: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: Any) -> FakeCompleted:
        del kwargs
        captured.append(command)
        python.parent.mkdir(parents=True, exist_ok=True)
        python.write_text("#!fake\n", encoding="utf-8")
        return FakeCompleted(0, stdout="synced")

    monkeypatch.setattr("backend.project_env.subprocess.run", fake_run)
    return python


# ---------------------------------------------------------------------------
# Create / scaffold
# ---------------------------------------------------------------------------


def test_create_scaffolds_the_complete_project_layout(manager: ProjectManager, tmp_path: Path):
    project = manager.create_project("my-project", str(tmp_path / "proj"))

    root = Path(project.root)
    for subdir in ("model", "stereotypes", "src", "assets", "datasets", "runs"):
        assert (root / subdir).is_dir(), f"missing scaffold directory {subdir}"
    assert (root / "nnmodelling.toml").is_file()
    assert (root / "pyproject.toml").is_file()
    graph = json.loads((root / "model" / "graph.json").read_text(encoding="utf-8"))
    assert graph == {"nodes": [], "edges": []}
    metadata = (root / "nnmodelling.toml").read_text(encoding="utf-8")
    assert f'schema_version = {PROJECT_SCHEMA_VERSION}' in metadata
    assert 'name = "my-project"' in metadata
    # The API key can never be part of the scaffolded project files.
    assert "api_key" not in metadata and "wandb" in metadata


def test_create_pyproject_pins_the_companion_python_minor(manager: ProjectManager, tmp_path: Path):
    project = manager.create_project("env", str(tmp_path / "proj"))
    pyproject = (Path(project.root) / "pyproject.toml").read_text(encoding="utf-8")
    assert f"=={sys.version_info.major}.{sys.version_info.minor}.*" in pyproject
    assert 'dependencies = ["mnist-fds"]' in pyproject
    assert "path =" in pyproject


def test_create_does_not_overwrite_a_nonempty_incompatible_directory(manager: ProjectManager, tmp_path: Path):
    root = tmp_path / "occupied"
    root.mkdir()
    (root / "keep.txt").write_text("keep me", encoding="utf-8")

    with pytest.raises(ProjectError) as excinfo:
        manager.create_project("proj", str(root))

    assert excinfo.value.code == "incompatible_root"
    assert (root / "keep.txt").read_text(encoding="utf-8") == "keep me"
    assert not (root / "nnmodelling.toml").exists()


def test_create_on_an_existing_project_requires_open(manager: ProjectManager, tmp_path: Path):
    first = manager.create_project("first", str(tmp_path / "proj"))
    _scaffold_valid_metadata(Path(first.root))

    with pytest.raises(ProjectError) as excinfo:
        manager.create_project("second", str(tmp_path / "proj"))

    assert excinfo.value.code == "project_exists"


def test_create_rejects_paths_that_are_not_directories(manager: ProjectManager, tmp_path: Path):
    file_path = tmp_path / "file.txt"
    file_path.write_text("x", encoding="utf-8")

    with pytest.raises(ProjectError) as excinfo:
        manager.create_project("proj", str(file_path))

    assert excinfo.value.code == "invalid_root"


def test_create_rejects_invalid_names(manager: ProjectManager, tmp_path: Path):
    with pytest.raises(ProjectError) as excinfo:
        manager.create_project("bad/name", str(tmp_path / "proj"))
    assert excinfo.value.code == "invalid_name"


def test_project_id_is_deterministic_from_the_normalized_root(tmp_path: Path):
    root = tmp_path / "proj"
    assert _project_id(root) == _project_id(root)
    assert _project_id(root) != _project_id(tmp_path / "other")
    assert len(_project_id(root)) == 16


def test_default_state_dir_honors_the_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("NNM_STATE_DIR", str(tmp_path / "state"))
    assert default_state_dir() == (tmp_path / "state").resolve()


# ---------------------------------------------------------------------------
# Open / metadata validation
# ---------------------------------------------------------------------------


def test_open_valid_project_reads_metadata_and_becomes_active(manager: ProjectManager, tmp_path: Path):
    root = tmp_path / "proj"
    _scaffold_valid_metadata(root, name="toml-name")

    project = manager.open_project(str(root))

    assert project.name == "toml-name"
    assert manager.active_project().id == project.id


def test_open_missing_root_is_actionable(manager: ProjectManager, tmp_path: Path):
    with pytest.raises(ProjectError) as excinfo:
        manager.open_project(str(tmp_path / "missing"))
    assert excinfo.value.code == "project_not_found"


def test_open_malformed_metadata_is_actionable_and_active_unchanged(manager: ProjectManager, tmp_path: Path):
    first = manager.create_project("first", str(tmp_path / "first"))

    bad_root = tmp_path / "bad"
    bad_root.mkdir()
    (bad_root / "nnmodelling.toml").write_text("this is [not valid toml", encoding="utf-8")

    with pytest.raises(ProjectError) as excinfo:
        manager.open_project(str(bad_root))

    assert excinfo.value.code == "metadata_invalid"
    assert "TOML" in str(excinfo.value)
    assert manager.active_project().id == first.id


def test_open_unsupported_schema_version_is_rejected(manager: ProjectManager, tmp_path: Path):
    first = manager.create_project("first", str(tmp_path / "first"))
    root = tmp_path / "future"
    root.mkdir()
    (root / "nnmodelling.toml").write_text('schema_version = 99\nname = "future"\n', encoding="utf-8")

    with pytest.raises(ProjectError) as excinfo:
        manager.open_project(str(root))

    assert excinfo.value.code == "metadata_unsupported"
    assert manager.active_project().id == first.id


def test_open_invalid_metadata_fields_are_rejected(manager: ProjectManager, tmp_path: Path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "nnmodelling.toml").write_text('schema_version = 1\nname = "x"\nmodel = 42\n', encoding="utf-8")

    with pytest.raises(ProjectError) as excinfo:
        manager.open_project(str(root))

    assert excinfo.value.code == "metadata_invalid"


def test_recent_projects_are_deduplicated_and_ordered(manager: ProjectManager, tmp_path: Path):
    first = manager.create_project("first", str(tmp_path / "first"))
    second = manager.create_project("second", str(tmp_path / "second"))

    manager.open_project(str(tmp_path / "first"))
    manager.open_project(str(tmp_path / "first"))  # same root must not duplicate

    recent = manager.list_projects()
    names = [project.name for project in recent.projects]
    assert names == ["first", "second"]
    assert recent.active.name == "first"
    assert len(recent.projects) == len(set(project.id for project in recent.projects))


def test_last_active_project_restores_on_restart(project_manager_factory, tmp_path: Path):
    first_manager = project_manager_factory()
    first_manager.create_project("active-one", str(tmp_path / "one"))
    last = first_manager.create_project("other", str(tmp_path / "two"))

    restarted = project_manager_factory()
    assert restarted.active_project() is not None
    assert restarted.active_project().id == last.id
    assert restarted.active_project().name == "other"


def test_listed_missing_projects_are_flagged_not_dropped(project_manager_factory, tmp_path: Path):
    created = project_manager_factory().create_project("gone", str(tmp_path / "gone"))
    project_root = Path(created.root)
    restarted = project_manager_factory()
    # Simulate the user deleting the project directory between restarts.
    (project_root / "nnmodelling.toml").unlink()

    recent = restarted.list_projects()
    assert [project.name for project in recent.projects] == ["gone"]
    assert recent.projects[0].exists is True
    assert recent.projects[0].metadata_valid is False
    assert recent.projects[0].metadata_error is not None


def test_forget_project_removes_registry_entry_and_secret(manager: ProjectManager, tmp_path: Path):
    project = manager.create_project("drop", str(tmp_path / "proj"))
    manager.set_wandb_key(project.id, "secret-value")

    manager.forget_project(project.id)

    assert not any(item.id == project.id for item in manager.list_projects().projects)
    assert manager.wandb_key_configured(project.id) is False
    assert Path(project.root).is_dir()  # files on disk are never deleted


def test_forget_unknown_project_is_actionable(manager: ProjectManager):
    with pytest.raises(ProjectError) as excinfo:
        manager.forget_project("does-not-exist")
    assert excinfo.value.code == "unknown_project"


# ---------------------------------------------------------------------------
# Graph persistence
# ---------------------------------------------------------------------------


def test_graph_write_and_read_roundtrip(manager: ProjectManager, tmp_path: Path):
    project = manager.create_project("graph", str(tmp_path / "proj"))

    graph = {"nodes": [{"id": "n1", "data": {"label": "x"}}], "edges": []}
    manager.write_graph(project.id, graph)

    assert manager.read_graph(project.id) == graph
    persisted = json.loads((Path(project.root) / "model" / "graph.json").read_text(encoding="utf-8"))
    assert persisted == graph
    # No leftover atomic-write temp files.
    assert [name for name in os.listdir(Path(project.root) / "model") if name.endswith(".tmp")] == []


def test_graph_read_missing_and_invalid_are_actionable(manager: ProjectManager, tmp_path: Path):
    project = manager.create_project("graph", str(tmp_path / "proj"))
    graph_path = Path(project.root) / "model" / "graph.json"
    graph_path.unlink()

    with pytest.raises(ProjectError) as excinfo:
        manager.read_graph(project.id)
    assert excinfo.value.code == "graph_missing"

    graph_path.write_text("{broken", encoding="utf-8")
    with pytest.raises(ProjectError) as excinfo:
        manager.read_graph(project.id)
    assert excinfo.value.code == "graph_invalid"


def test_graph_model_path_cannot_escape_the_root(manager: ProjectManager, tmp_path: Path):
    root = tmp_path / "proj"
    root.mkdir()
    outside = tmp_path / "outside.json"
    outside.write_text("{}", encoding="utf-8")
    (root / "nnmodelling.toml").write_text(
        f'schema_version = {PROJECT_SCHEMA_VERSION}\nname = "x"\nmodel = "../outside.json"\n',
        encoding="utf-8",
    )

    with pytest.raises(ProjectError) as excinfo:
        manager.open_project(str(root))
    assert excinfo.value.code == "path_escape"


def test_graph_model_path_cannot_follow_a_symlink_out_of_the_root(manager: ProjectManager, tmp_path: Path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "model").mkdir()
    outside = tmp_path / "outside.json"
    outside.write_text("{}", encoding="utf-8")
    (root / "model" / "link.json").symlink_to(outside)
    (root / "nnmodelling.toml").write_text(
        f'schema_version = {PROJECT_SCHEMA_VERSION}\nname = "x"\nmodel = "model/link.json"\n',
        encoding="utf-8",
    )

    with pytest.raises(ProjectError) as excinfo:
        manager.open_project(str(root))
    assert excinfo.value.code == "path_escape"


def test_absolute_model_path_is_rejected(manager: ProjectManager, tmp_path: Path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "nnmodelling.toml").write_text(
        f'schema_version = {PROJECT_SCHEMA_VERSION}\nname = "x"\nmodel = "/etc/passwd"\n',
        encoding="utf-8",
    )

    with pytest.raises(ProjectError) as excinfo:
        manager.open_project(str(root))
    assert excinfo.value.code == "path_escape"


# ---------------------------------------------------------------------------
# W&B configuration and secrets
# ---------------------------------------------------------------------------


def test_wandb_key_is_stored_owner_only_and_never_in_project_files(manager: ProjectManager, tmp_path: Path):
    project = manager.create_project("wandb", str(tmp_path / "proj"))
    manager.set_wandb_key(project.id, "super-secret-key")

    secrets_path = tmp_path / "state" / "secrets.json"
    assert stat.S_IMODE(os.stat(secrets_path).st_mode) == 0o600
    secrets = json.loads(secrets_path.read_text(encoding="utf-8"))
    assert secrets["secrets"][project.id] == "super-secret-key"

    # The key is absent from every other companion file and project file.
    state_text = (tmp_path / "state" / "projects.json").read_text(encoding="utf-8")
    project_text = (Path(project.root) / "nnmodelling.toml").read_text(encoding="utf-8")
    assert "super-secret-key" not in state_text
    assert "super-secret-key" not in project_text

    assert manager.wandb_api_key(project.id) == "super-secret-key"
    settings, configured = manager.read_wandb(project.id)
    assert configured is True
    assert settings.model_dump().get("api_key") is None


def test_wandb_key_delete_and_missing_key(manager: ProjectManager, tmp_path: Path):
    project = manager.create_project("wandb", str(tmp_path / "proj"))

    assert manager.wandb_key_configured(project.id) is False
    assert manager.wandb_api_key(project.id) is None

    manager.set_wandb_key(project.id, "secret")
    manager.delete_wandb_key(project.id)
    assert manager.wandb_key_configured(project.id) is False


def test_wandb_key_rejects_oversized_values(manager: ProjectManager, tmp_path: Path):
    project = manager.create_project("wandb", str(tmp_path / "proj"))

    with pytest.raises(ProjectError) as excinfo:
        manager.set_wandb_key(project.id, "k" * 201)
    assert excinfo.value.code == "invalid_secret"


def test_wandb_settings_update_merges_into_toml(manager: ProjectManager, tmp_path: Path):
    from backend.project_schema import WandbUpdate

    project = manager.create_project("wandb", str(tmp_path / "proj"))

    settings = manager.update_wandb(
        project.id,
        WandbUpdate(entity="team", project="my-runs", tags=["t1", "t2"]),
    )
    assert settings.entity == "team"
    assert settings.project == "my-runs"
    assert settings.tags == ["t1", "t2"]

    toml = (Path(project.root) / "nnmodelling.toml").read_text(encoding="utf-8")
    assert 'entity = "team"' in toml
    assert 'tags = ["t1", "t2"]' in toml
    # Fields not supplied keep their defaults.
    assert settings.mode == "online"


# ---------------------------------------------------------------------------
# Environment synchronization
# ---------------------------------------------------------------------------


def test_environment_sync_success_reports_ready(manager: ProjectManager, tmp_path: Path, monkeypatch):
    project = manager.create_project("env", str(tmp_path / "proj"))
    python = _patch_uv_success(monkeypatch, Path(project.root))

    synced = manager.sync_project(project.id)

    assert synced.environment.status == "ready"
    assert synced.environment.python == str(python)
    assert synced.environment.synced_at is not None


def test_environment_sync_runs_uv_with_the_project_root(manager: ProjectManager, tmp_path: Path, monkeypatch):
    project = manager.create_project("env", str(tmp_path / "proj"))
    python = project_python(project.root)
    python.parent.mkdir(parents=True, exist_ok=True)
    python.write_text("#!fake\n", encoding="utf-8")
    captured: list[list[str]] = []
    monkeypatch.setattr(
        "backend.project_env.subprocess.run",
        lambda command, **kwargs: captured.append(command) or FakeCompleted(0),
    )

    manager.sync_project(project.id)

    assert captured[0][1:3] == ["sync", "--project"]
    assert Path(captured[0][3]) == Path(project.root)


def test_environment_sync_uv_missing_is_surfaced_without_fallback(
    tmp_path: Path,
    monkeypatch,
):
    monkeypatch.setattr("backend.projects.find_uv", lambda: None)
    monkeypatch.setattr("backend.project_env.find_uv", lambda: None)
    manager = ProjectManager(tmp_path / "state", sync_enabled=False)
    project = manager.create_project("env", str(tmp_path / "proj"))

    synced = manager.sync_project(project.id)

    assert synced.environment.status == "error"
    assert "uv is not installed" in synced.environment.message
    # The interpreter stays the project venv; never the companion's.
    assert synced.environment.python.endswith(".venv/bin/python")


def test_environment_sync_failure_is_surfaced_without_interpreter_fallback(
    manager: ProjectManager,
    tmp_path: Path,
    monkeypatch,
):
    project = manager.create_project("env", str(tmp_path / "proj"))
    monkeypatch.setattr(
        "backend.project_env.subprocess.run",
        lambda command, **kwargs: FakeCompleted(1, stderr="error: failed to install torch"),
    )

    synced = manager.sync_project(project.id)

    assert synced.environment.status == "error"
    assert "failed to install torch" in synced.environment.message
    assert synced.environment.python.endswith(".venv/bin/python")


def test_environment_sync_failure_state_persists_across_restart(project_manager_factory, tmp_path: Path, monkeypatch):
    first_manager = project_manager_factory()
    project = first_manager.create_project("env", str(tmp_path / "proj"))
    monkeypatch.setattr(
        "backend.project_env.subprocess.run",
        lambda command, **kwargs: FakeCompleted(1, stderr="boom"),
    )
    first_manager.sync_project(project.id)

    restarted = project_manager_factory()
    assert restarted.get_project(project.id).environment.status == "error"


def test_environment_sync_uv_executable_missing_raises_actionable_error(tmp_path: Path, monkeypatch):
    from backend.project_env import sync_project_environment

    monkeypatch.setattr("backend.project_env.find_uv", lambda: "/nonexistent/uv")

    with pytest.raises(EnvironmentSyncError) as excinfo:
        sync_project_environment(tmp_path)
    assert excinfo.value.code == "uv_missing"
    assert "uv" in str(excinfo.value)


def test_environment_sync_timeout_is_actionable(tmp_path: Path, monkeypatch):
    import subprocess

    from backend.project_env import sync_project_environment

    monkeypatch.setattr("backend.project_env.find_uv", lambda: "/usr/bin/uv")

    def fake_run(command, **kwargs):
        raise subprocess.TimeoutExpired(command, 30)

    monkeypatch.setattr("backend.project_env.subprocess.run", fake_run)

    with pytest.raises(EnvironmentSyncError) as excinfo:
        sync_project_environment(tmp_path, timeout=30)
    assert excinfo.value.code == "sync_timeout"


# ---------------------------------------------------------------------------
# Stereotype catalog
# ---------------------------------------------------------------------------


def _write_project_stereotypes(root: Path) -> None:
    stereotypes_dir = root / "stereotypes"
    stereotypes_dir.mkdir(exist_ok=True)
    (stereotypes_dir / "MyLayer.json").write_text(
        json.dumps(
            {
                "category": "Layer",
                "pythonClassName": "nn.Linear",
                "params": {"in_features": {"type": "int", "default": "Undefined"}},
            }
        ),
        encoding="utf-8",
    )
    (stereotypes_dir / "Broken.json").write_text("{not json", encoding="utf-8")
    # Deliberate collision with the built-in Linear stereotype.
    (stereotypes_dir / "Linear.json").write_text(
        json.dumps({"category": "Layer", "pythonClassName": "nn.Linear"}),
        encoding="utf-8",
    )
    # Duplicate project name in a subdirectory.
    (stereotypes_dir / "joins").mkdir(exist_ok=True)
    (stereotypes_dir / "joins" / "MyLayer.json").write_text(
        json.dumps({"category": "Join", "pythonClassName": "ops.Addition"}),
        encoding="utf-8",
    )


def test_stereotype_catalog_serves_builtins_plus_project_definitions(manager: ProjectManager, tmp_path: Path):
    project = manager.create_project("stereos", str(tmp_path / "proj"))
    _write_project_stereotypes(Path(project.root))

    catalog = manager.project_stereotypes(project.id)

    names = {entry.name for entry in catalog.stereotypes}
    assert "Linear" in names  # built-in retained despite the project collision
    assert "MyLayer" in names
    my_layer = next(entry for entry in catalog.stereotypes if entry.name == "MyLayer")
    assert my_layer.source == "project"
    assert my_layer.data["pythonClassName"] == "nn.Linear"
    assert my_layer.id.startswith("project-stereotypes/")
    builtin = next(entry for entry in catalog.stereotypes if entry.id.startswith("Stereotypes/"))
    assert builtin.source == "builtin"


def test_stereotype_catalog_diagnoses_malformed_and_colliding_definitions(
    manager: ProjectManager,
    tmp_path: Path,
):
    project = manager.create_project("stereos", str(tmp_path / "proj"))
    _write_project_stereotypes(Path(project.root))

    catalog = manager.project_stereotypes(project.id)
    errors = {error["path"]: error["error"] for error in catalog.errors}

    assert any("invalid JSON" in message for path, message in errors.items() if path == "Broken.json")
    collision = next(
        (message for path, message in errors.items() if "Linear" in path),
        None,
    )
    assert collision is not None and "collides with a built-in" in collision
    duplicate = next(
        (message for path, message in errors.items() if "joins/MyLayer.json" in path),
        None,
    )
    assert duplicate is not None and "duplicate" in duplicate
    # Colliding project names never appear in the catalog.
    names = {entry.name for entry in catalog.stereotypes}
    assert sum(name == "MyLayer" for name in names) == 1


def test_stereotype_catalog_rejects_structurally_invalid_definitions(manager: ProjectManager, tmp_path: Path):
    project = manager.create_project("stereos", str(tmp_path / "proj"))
    stereotypes_dir = Path(project.root) / "stereotypes"
    (stereotypes_dir / "bad-params.json").write_text(
        json.dumps({"category": "Layer", "params": [1, 2]}),
        encoding="utf-8",
    )
    (stereotypes_dir / "bad-category.json").write_text(
        json.dumps({"category": "NotACategory"}),
        encoding="utf-8",
    )

    catalog = manager.project_stereotypes(project.id)

    errors = {error["path"]: error["error"] for error in catalog.errors}
    assert "params must be a JSON object" in errors["bad-params.json"]
    assert "not recognized" in errors["bad-category.json"]


def test_project_stereotype_catalog_does_not_read_symlinked_files_outside_project(
    manager: ProjectManager,
    tmp_path: Path,
):
    """Catalog discovery must not expose JSON reachable only through a symlink."""
    project = manager.create_project("stereos", str(tmp_path / "proj"))
    outside = tmp_path / "outside.json"
    outside.write_text(
        json.dumps({"category": "Layer", "private_value": "must-not-leak"}),
        encoding="utf-8",
    )
    (Path(project.root) / "stereotypes" / "Outside.json").symlink_to(outside)

    catalog = manager.project_stereotypes(project.id)

    assert "Outside" not in {entry.name for entry in catalog.stereotypes}
    assert "must-not-leak" not in json.dumps(catalog.model_dump())


def test_project_stereotype_catalog_ignores_directory_symlinks_outside_project(
    manager: ProjectManager,
    tmp_path: Path,
):
    """A directory symlink must never expose JSON from outside stereotypes/."""
    project = manager.create_project("stereos", str(tmp_path / "proj"))
    outside_dir = tmp_path / "outside-stereos"
    outside_dir.mkdir()
    (outside_dir / "Leaked.json").write_text(
        json.dumps({"category": "Layer", "private_value": "dir-leak"}),
        encoding="utf-8",
    )
    (Path(project.root) / "stereotypes" / "OutsideDir").symlink_to(outside_dir)
    # Valid in-tree definitions must still be discovered.
    (Path(project.root) / "stereotypes" / "GoodLayer.json").write_text(
        json.dumps({"category": "Layer", "pythonClassName": "nn.Linear"}),
        encoding="utf-8",
    )

    catalog = manager.project_stereotypes(project.id)

    names = {entry.name for entry in catalog.stereotypes}
    assert "GoodLayer" in names
    assert "Leaked" not in names
    assert "dir-leak" not in json.dumps(catalog.model_dump())


def test_project_stereotype_catalog_diagnoses_broken_symlinks_outside_project(
    manager: ProjectManager,
    tmp_path: Path,
):
    """A broken symlink whose target escapes the root is diagnosed, not read."""
    project = manager.create_project("stereos", str(tmp_path / "proj"))
    (Path(project.root) / "stereotypes" / "Broken.json").symlink_to(
        tmp_path / "missing.json"
    )

    catalog = manager.project_stereotypes(project.id)

    assert "Broken" not in {entry.name for entry in catalog.stereotypes}
    broken_errors = [
        error for error in catalog.errors if error["path"] == "Broken.json"
    ]
    assert broken_errors and "resolves outside" in broken_errors[0]["error"]


def test_builtin_catalog_loads_every_repository_stereotype():
    from backend.stereotype_registry import load_builtin_stereotypes

    builtin, errors = load_builtin_stereotypes()
    assert len(builtin) >= 35
    assert errors == []
    ids = {entry.id for entry in builtin}
    assert "Stereotypes/Modules/Linear.json" in ids
    assert "Stereotypes/Joins/Addition.json" in ids
    assert "Stereotypes/SubFlows/Repeat.json" in ids


# ---------------------------------------------------------------------------
# Dataset catalog
# ---------------------------------------------------------------------------


def _write_project_datasets(root: Path) -> None:
    datasets_dir = root / "datasets"
    datasets_dir.mkdir(exist_ok=True)
    (datasets_dir / "my_ds.py").write_text(
        "\n".join(
            [
                "from dataset.ds import Dataset",
                "",
                "class MyDataset(Dataset):",
                "    @classmethod",
                "    def num_classes(cls, config):",
                "        return 3",
                "",
                "    def division(self):",
                "        raise NotImplementedError",
                "",
                "class NotADataset:",
                "    pass",
            ]
        ),
        encoding="utf-8",
    )
    (datasets_dir / "broken_ds.py").write_text('raise RuntimeError("boom")\n', encoding="utf-8")
    (datasets_dir / "bad_count.py").write_text(
        "\n".join(
            [
                "from dataset.ds import Dataset",
                "",
                "class BadCount(Dataset):",
                "    @classmethod",
                "    def num_classes(cls, config):",
                "        return -5",
                "",
                "    def division(self):",
                "        raise NotImplementedError",
            ]
        ),
        encoding="utf-8",
    )


def test_project_dataset_catalog_finds_validated_subclasses(manager: ProjectManager, tmp_path: Path):
    project = manager.create_project("datasets", str(tmp_path / "proj"))
    _write_project_datasets(Path(project.root))

    catalog = manager.project_datasets(project.id)

    targets = {dataset.target: dataset for dataset in catalog.datasets}
    assert targets["my_ds.MyDataset"].source == "project"
    assert targets["my_ds.MyDataset"].num_classes == 3
    assert "NotADataset" not in " ".join(targets)
    # Installed built-ins remain available alongside project datasets.
    assert "dataset.mnist.MNISTDataset" in targets
    assert targets["dataset.mnist.MNISTDataset"].source == "builtin"


def test_project_dataset_catalog_reports_module_errors_without_failing(
    manager: ProjectManager,
    tmp_path: Path,
):
    project = manager.create_project("datasets", str(tmp_path / "proj"))
    _write_project_datasets(Path(project.root))

    catalog = manager.project_datasets(project.id)

    errors = {error.path: error.error for error in catalog.errors}
    assert "boom" in errors["broken_ds.py"]
    assert "num_classes must return a positive integer" in errors["bad_count.py"]
    assert "BadCount" not in {dataset.target for dataset in catalog.datasets}


def test_project_dataset_discovery_does_not_leak_import_state(manager: ProjectManager, tmp_path: Path):
    project = manager.create_project("datasets", str(tmp_path / "proj"))
    _write_project_datasets(Path(project.root))
    datasets_dir = str(Path(project.root) / "datasets")

    modules_before = set(sys.modules)
    path_before = list(sys.path)

    discovery = discover_project_datasets(Path(project.root))

    assert any(dataset.target == "my_ds.MyDataset" for dataset in discovery.datasets)
    assert set(sys.modules) - modules_before == set()
    assert sys.path == path_before
    assert datasets_dir not in sys.path


def test_project_dataset_discovery_does_not_import_symlinked_code_outside_project(
    manager: ProjectManager,
    tmp_path: Path,
):
    """Only dataset modules physically below ``datasets/`` may be executed."""
    project = manager.create_project("datasets", str(tmp_path / "proj"))
    outside = tmp_path / "outside_dataset.py"
    outside.write_text(
        "from dataset.ds import Dataset\n"
        "class OutsideDataset(Dataset):\n"
        "    def division(self):\n"
        "        raise NotImplementedError\n",
        encoding="utf-8",
    )
    (Path(project.root) / "datasets" / "outside_dataset.py").symlink_to(outside)

    discovery = discover_project_datasets(Path(project.root))

    assert "outside_dataset.OutsideDataset" not in {dataset.target for dataset in discovery.datasets}


def test_project_dataset_discovery_ignores_directory_symlinks_outside_project(
    manager: ProjectManager,
    tmp_path: Path,
):
    """A directory symlink must never execute code from outside datasets/."""
    project = manager.create_project("datasets", str(tmp_path / "proj"))
    outside_dir = tmp_path / "outside-datasets"
    outside_dir.mkdir()
    (outside_dir / "leaked.py").write_text(
        "from dataset.ds import Dataset\n"
        "class LeakedDataset(Dataset):\n"
        "    def division(self):\n"
        "        raise NotImplementedError\n",
        encoding="utf-8",
    )
    (Path(project.root) / "datasets" / "outside-dir").symlink_to(outside_dir)
    # Valid in-tree modules must still be discovered.
    (Path(project.root) / "datasets" / "valid.py").write_text(
        "from dataset.ds import Dataset\n"
        "class ValidDataset(Dataset):\n"
        "    def division(self):\n"
        "        raise NotImplementedError\n",
        encoding="utf-8",
    )

    discovery = discover_project_datasets(Path(project.root))

    targets = {dataset.target for dataset in discovery.datasets}
    assert "valid.ValidDataset" in targets
    assert "leaked.LeakedDataset" not in targets


def test_project_dataset_discovery_diagnoses_broken_symlinks_outside_project(
    manager: ProjectManager,
    tmp_path: Path,
):
    """A broken symlink whose target escapes datasets/ is diagnosed, not run."""
    project = manager.create_project("datasets", str(tmp_path / "proj"))
    (Path(project.root) / "datasets" / "broken.py").symlink_to(
        tmp_path / "missing_dataset.py"
    )

    discovery = discover_project_datasets(Path(project.root))

    assert "broken.BrokenDataset" not in {dataset.target for dataset in discovery.datasets}
    broken_errors = [error for error in discovery.errors if error["path"] == "broken.py"]
    assert broken_errors and "resolves outside" in broken_errors[0]["error"]


def test_legacy_dataset_discovery_signature_is_preserved():
    datasets = discover_datasets()
    assert {dataset.target for dataset in datasets} >= {
        "dataset.mnist.MNISTDataset",
        "dataset.enron_spam.EnronSpamDataset",
    }
    assert all(dataset.source == "builtin" for dataset in datasets)


def test_project_dataset_discovery_of_a_second_project_is_fresh(manager: ProjectManager, tmp_path: Path):
    first = manager.create_project("one", str(tmp_path / "one"))
    second = manager.create_project("two", str(tmp_path / "two"))
    (Path(first.root) / "datasets").mkdir(exist_ok=True)
    (Path(first.root) / "datasets" / "shared.py").write_text(
        "from dataset.ds import Dataset\nclass SharedA(Dataset):\n    def division(self):\n        raise NotImplementedError\n",
        encoding="utf-8",
    )
    (Path(second.root) / "datasets").mkdir(exist_ok=True)
    (Path(second.root) / "datasets" / "shared.py").write_text(
        "from dataset.ds import Dataset\nclass SharedB(Dataset):\n    def division(self):\n        raise NotImplementedError\n",
        encoding="utf-8",
    )

    first_catalog = manager.project_datasets(first.id)
    second_catalog = manager.project_datasets(second.id)

    first_targets = {dataset.target for dataset in first_catalog.datasets}
    second_targets = {dataset.target for dataset in second_catalog.datasets}
    assert "shared.SharedA" in first_targets
    assert "shared.SharedB" in second_targets
    # The first project's module state must not leak into the second scan.
    assert "shared.SharedA" not in second_targets
    assert "shared.SharedB" not in first_targets


# ---------------------------------------------------------------------------
# Companion state corruption
# ---------------------------------------------------------------------------


def test_corrupt_state_file_is_actionable(manager: ProjectManager, tmp_path: Path):
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    (state_dir / "projects.json").write_text("{corrupt", encoding="utf-8")

    with pytest.raises(ProjectError) as excinfo:
        manager.create_project("proj", str(tmp_path / "proj"))
    assert excinfo.value.code == "state_corrupt"
    assert "projects.json" in str(excinfo.value)


def test_corrupt_secrets_file_is_actionable(project_manager_factory, tmp_path: Path):
    first_manager = project_manager_factory()
    project = first_manager.create_project("proj", str(tmp_path / "proj"))
    (tmp_path / "state" / "secrets.json").write_text("{corrupt", encoding="utf-8")

    # A fresh manager has not cached the (now corrupt) secrets file.
    fresh_manager = project_manager_factory()
    with pytest.raises(ProjectError) as excinfo:
        fresh_manager.wandb_key_configured(project.id)
    assert excinfo.value.code == "secrets_corrupt"


# ---------------------------------------------------------------------------
# Job submission contract
# ---------------------------------------------------------------------------


def test_job_submission_accepts_an_optional_project_id():
    from backend.models import ResourceRequest

    payload = {
        "network": {"format": "nntree", "value": {"nodes": [], "edges": []}},
        "training": {
            "dataset": {"_target_": "dataset.mnist.MNISTDataset"},
            "trainer": {"max_epochs": 1},
        },
        "resources": ResourceRequest(cpu=1, memory_gb=1, gpu=0),
        "project_id": "fb2617ccb9f44282",
    }
    submission = JobSubmission.model_validate(payload)
    assert submission.project_id == "fb2617ccb9f44282"


def test_job_submission_rejects_path_like_project_ids():
    from backend.models import ResourceRequest

    payload = {
        "network": {"format": "nntree", "value": {"nodes": [], "edges": []}},
        "training": {"dataset": {"_target_": "dataset.mnist.MNISTDataset"}, "trainer": {"max_epochs": 1}},
        "resources": ResourceRequest(cpu=1, memory_gb=1, gpu=0),
        "project_id": "../etc/passwd",
    }
    with pytest.raises(ValueError, match="project_id"):
        JobSubmission.model_validate(payload)


# ---------------------------------------------------------------------------
# HTTP API wiring
# ---------------------------------------------------------------------------


def _api_context(tmp_path: Path, manager: JobManager, project_manager: ProjectManager):
    auth = AuthService(InMemoryAuthStore())
    pairing = auth.create_pairing("Browser", client_host="127.0.0.1")
    auth.approve(pairing.request_id)
    app = create_app(
        manager,
        auth_service=auth,
        admin_token="admin-secret",
        project_manager=project_manager,
    )
    return app, pairing.token


def _authed_headers(token: str) -> dict[str, str]:
    return {"authorization": f"Bearer {token}"}


@pytest.fixture()
def api(tmp_path: Path, manager: ProjectManager):
    """Authenticated ASGI app with an isolated project manager."""

    class Context:
        def __init__(self) -> None:
            job_manager = JobManager(InMemoryJobStore(), tmp_path / "jobs", [NoopExecutor()])
            self.app, self.token = _api_context(tmp_path, job_manager, manager)

        def client(self) -> httpx.AsyncClient:
            transport = httpx.ASGITransport(app=self.app)
            return httpx.AsyncClient(transport=transport, base_url="http://test")

    return Context()


def test_project_endpoints_require_authentication(api):
    async def exercise() -> None:
        async with api.app.router.lifespan_context(api.app):
            async with api.client() as client:
                assert (await client.get("/projects")).status_code == 401
                assert (await client.post("/projects", json={"root": "/tmp/x"})).status_code == 401
                assert (await client.get("/projects/active")).status_code == 401

    asyncio.run(exercise())


def test_project_api_create_open_list_active_flow(api, tmp_path: Path):
    headers = _authed_headers(api.token)

    async def exercise() -> None:
        async with api.app.router.lifespan_context(api.app):
            async with api.client() as client:
                created = await client.post(
                    "/projects",
                    headers=headers,
                    json={"name": "api-proj", "root": str(tmp_path / "proj")},
                )
                assert created.status_code == 201
                project_id = created.json()["id"]
                assert created.json()["name"] == "api-proj"

                active = await client.get("/projects/active", headers=headers)
                assert active.json()["id"] == project_id

                listed = await client.get("/projects", headers=headers)
                assert [project["name"] for project in listed.json()["projects"]] == ["api-proj"]

                opened = await client.post(
                    "/projects/open",
                    headers=headers,
                    json={"root": str(tmp_path / "proj")},
                )
                assert opened.status_code == 200
                assert opened.json()["id"] == project_id

                unknown = await client.get(f"/projects/{project_id[:4]}-missing", headers=headers)
                assert unknown.status_code == 404
                assert unknown.json()["detail"]["code"] == "unknown_project"

                removed = await client.delete(f"/projects/{project_id}", headers=headers)
                assert removed.status_code == 200
                assert (await client.get("/projects/active", headers=headers)).status_code == 404

    asyncio.run(exercise())


def test_project_api_failed_open_keeps_active_project_and_graph(api, tmp_path: Path):
    headers = _authed_headers(api.token)

    async def exercise() -> None:
        async with api.app.router.lifespan_context(api.app):
            async with api.client() as client:
                created = await client.post(
                    "/projects",
                    headers=headers,
                    json={"name": "good", "root": str(tmp_path / "good")},
                )
                project_id = created.json()["id"]
                await client.put(
                    f"/projects/{project_id}/graph",
                    headers=headers,
                    json={"nodes": [{"id": "keep"}], "edges": []},
                )

                bad_root = tmp_path / "bad"
                bad_root.mkdir()
                (bad_root / "nnmodelling.toml").write_text("not [valid", encoding="utf-8")
                failed = await client.post("/projects/open", headers=headers, json={"root": str(bad_root)})
                assert failed.status_code == 422
                assert failed.json()["detail"]["code"] == "metadata_invalid"

                active = await client.get("/projects/active", headers=headers)
                assert active.json()["id"] == project_id
                graph = await client.get(f"/projects/{project_id}/graph", headers=headers)
                assert graph.json() == {"nodes": [{"id": "keep"}], "edges": []}

    asyncio.run(exercise())


def test_project_api_graph_endpoints(api, tmp_path: Path):
    headers = _authed_headers(api.token)

    async def exercise() -> None:
        async with api.app.router.lifespan_context(api.app):
            async with api.client() as client:
                created = await client.post(
                    "/projects",
                    headers=headers,
                    json={"name": "graph", "root": str(tmp_path / "proj")},
                )
                project_id = created.json()["id"]
                graph_path = tmp_path / "proj" / "model" / "graph.json"
                original = graph_path.read_text(encoding="utf-8")

                saved = await client.put(
                    f"/projects/{project_id}/graph",
                    headers=headers,
                    json={"nodes": [{"id": "n1"}], "edges": []},
                )
                assert saved.status_code == 200
                assert saved.json()["nodes"][0]["id"] == "n1"

                read_back = await client.get(f"/projects/{project_id}/graph", headers=headers)
                assert read_back.json() == {"nodes": [{"id": "n1"}], "edges": []}

                # A non-object body is rejected without touching the file.
                rejected = await client.put(
                    f"/projects/{project_id}/graph",
                    headers=headers,
                    json=[1, 2, 3],
                )
                assert rejected.status_code == 422
                assert json.loads(graph_path.read_text(encoding="utf-8")) == {"nodes": [{"id": "n1"}], "edges": []}
                del original

    asyncio.run(exercise())


def test_project_api_wandb_key_never_appears_in_responses(api, tmp_path: Path):
    headers = _authed_headers(api.token)

    async def exercise() -> None:
        async with api.app.router.lifespan_context(api.app):
            async with api.client() as client:
                created = await client.post(
                    "/projects",
                    headers=headers,
                    json={"name": "wandb", "root": str(tmp_path / "proj")},
                )
                project_id = created.json()["id"]

                updated = await client.put(
                    f"/projects/{project_id}/wandb",
                    headers=headers,
                    json={"entity": "team", "project": "runs", "tags": ["a"]},
                )
                assert updated.json()["entity"] == "team"

                stored = await client.put(
                    f"/projects/{project_id}/wandb-key",
                    headers=headers,
                    json={"api_key": "super-secret-key"},
                )
                assert stored.json() == {"configured": True}

                settings = await client.get(f"/projects/{project_id}/wandb", headers=headers)
                body = json.dumps(settings.json())
                assert "super-secret-key" not in body
                assert settings.json()["api_key_configured"] is True

                summary = await client.get(f"/projects/{project_id}", headers=headers)
                assert "super-secret-key" not in json.dumps(summary.json())
                assert summary.json()["api_key_configured"] is True

                deleted = await client.delete(f"/projects/{project_id}/wandb-key", headers=headers)
                assert deleted.json() == {"configured": False}
                after = await client.get(f"/projects/{project_id}/wandb", headers=headers)
                assert after.json()["api_key_configured"] is False

    asyncio.run(exercise())


def test_project_api_stereotype_and_dataset_catalogs(api, tmp_path: Path):
    headers = _authed_headers(api.token)

    async def exercise() -> None:
        async with api.app.router.lifespan_context(api.app):
            async with api.client() as client:
                created = await client.post(
                    "/projects",
                    headers=headers,
                    json={"name": "catalogs", "root": str(tmp_path / "proj")},
                )
                project_id = created.json()["id"]
                _write_project_stereotypes(tmp_path / "proj")
                _write_project_datasets(tmp_path / "proj")

                stereotypes = await client.get(f"/projects/{project_id}/stereotypes", headers=headers)
                assert stereotypes.status_code == 200
                names = {entry["name"] for entry in stereotypes.json()["stereotypes"]}
                assert "MyLayer" in names and "Linear" in names
                assert any("collides with a built-in" in error["error"] for error in stereotypes.json()["errors"])

                datasets = await client.get(f"/projects/{project_id}/datasets", headers=headers)
                assert datasets.status_code == 200
                targets = {entry["target"] for entry in datasets.json()["datasets"]}
                assert "my_ds.MyDataset" in targets
                assert any("boom" in error["error"] for error in datasets.json()["errors"])

    asyncio.run(exercise())


def test_legacy_datasets_endpoint_remains_compatible(api):
    headers = _authed_headers(api.token)

    async def exercise() -> None:
        async with api.app.router.lifespan_context(api.app):
            async with api.client() as client:
                response = await client.get("/datasets", headers=headers)
                assert response.status_code == 200
                datasets = response.json()
                assert any(entry["name"] == "MNISTDataset" for entry in datasets)
                assert all(entry["source"] == "builtin" for entry in datasets)

    asyncio.run(exercise())


# ---------------------------------------------------------------------------
# Composition root: production JobManager wiring (S1-INTEGRATION)
# ---------------------------------------------------------------------------


def test_create_app_wires_production_manager_to_the_project_service(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    """The environment-built JobManager must share the app's ProjectManager.

    In production ``create_app`` constructs ``JobManager.from_environment``
    itself; without wiring, ``project_id`` submissions would reach a manager
    with ``project_manager=None`` and fail to resolve any project. The wiring
    contract is that the same instance exposed as ``app.state.projects`` is
    passed into ``JobManager.from_environment(project_manager=...)``.
    """

    captured: dict[str, object] = {}

    def fake_from_environment(*args: Any, **kwargs: Any) -> JobManager:
        del args
        project_manager = kwargs.get("project_manager")
        captured["project_manager"] = project_manager
        return JobManager(
            InMemoryJobStore(),
            tmp_path / "jobs",
            [NoopExecutor()],
            project_manager=project_manager,
        )

    monkeypatch.setattr(JobManager, "from_environment", classmethod(fake_from_environment))

    app = create_app()

    assert captured["project_manager"] is app.state.projects
    assert app.state.manager.project_manager is app.state.projects


def test_create_app_preserves_an_injected_manager(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    """An explicitly injected JobManager is never rebuilt or rewired.

    Existing tests (and deployments) inject the manager together with the
    auth service; the composition-root wiring must only apply to the
    environment-built manager and must not call ``from_environment`` or
    replace the injected project manager.
    """

    injected_manager = JobManager(InMemoryJobStore(), tmp_path / "jobs", [NoopExecutor()])
    injected_projects = ProjectManager(tmp_path / "state", sync_enabled=False)

    def unexpected_from_environment(*args: Any, **kwargs: Any) -> JobManager:
        del args, kwargs
        raise AssertionError("from_environment must not run for an injected manager")

    monkeypatch.setattr(JobManager, "from_environment", classmethod(unexpected_from_environment))

    app = create_app(injected_manager, project_manager=injected_projects)

    assert app.state.manager is injected_manager
    assert app.state.projects is injected_projects
    assert app.state.manager.project_manager is None
