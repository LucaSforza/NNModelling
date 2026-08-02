"""Pydantic models for the NNModelling project workspace.

The project workspace persists a versioned ``nnmodelling.toml`` per project,
a companion-owned recent-project registry, and owner-only companion secrets.
This module defines the metadata schema shared by the filesystem layer and the
project APIs. The W&B API key is never part of any model here: project files
and API responses only ever expose ``api_key_configured``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.models import DatasetInfo

PROJECT_SCHEMA_VERSION = 1
WANDB_KEY_MAX_LENGTH = 200


class WandbSettings(BaseModel):
    """Non-secret W&B settings persisted in ``nnmodelling.toml``.

    The API key itself is deliberately absent: it lives in the companion
    secrets file with owner-only permissions and is injected only into child
    training processes by the job manager.
    """

    entity: str = ""
    project: str = "NeuralNetworks"
    tags: list[str] = Field(default_factory=list)
    run_name_template: str = ""
    mode: Literal["online", "offline", "disabled"] = "online"


class ProjectMetadata(BaseModel):
    """Versioned project metadata persisted as ``nnmodelling.toml``."""

    schema_version: int = PROJECT_SCHEMA_VERSION
    name: str
    model: str = "model/graph.json"
    wandb: WandbSettings = Field(default_factory=WandbSettings)


class EnvironmentState(BaseModel):
    """Companion-observed state of a project's uv-managed environment.

    ``status`` is one of ``ready`` (the venv interpreter exists and the last
    sync succeeded), ``missing`` (never synchronized, no interpreter yet), or
    ``error`` (the last uv sync failed; the message carries the actionable
    detail). ``python`` always names the intended project interpreter; the
    companion never falls back to its own interpreter for a project job.
    """

    status: Literal["ready", "missing", "error"]
    python: str
    message: str = ""
    synced_at: str | None = None


class ProjectSummary(BaseModel):
    """Public project response returned by create/open/list/get APIs."""

    id: str
    name: str
    root: str
    model: str
    environment: EnvironmentState
    wandb: WandbSettings
    api_key_configured: bool = False
    last_opened: str
    exists: bool = True
    metadata_valid: bool = True
    metadata_error: str | None = None


class RecentProjectsResponse(BaseModel):
    """Recent projects ordered by last-opened time plus the active project."""

    active: ProjectSummary | None = None
    projects: list[ProjectSummary] = Field(default_factory=list)


class CreateProjectRequest(BaseModel):
    """Body of ``POST /projects``."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=80)
    root: str


class OpenProjectRequest(BaseModel):
    """Body of ``POST /projects/open``."""

    model_config = ConfigDict(extra="forbid")

    root: str


class WandbUpdate(BaseModel):
    """Optional non-secret W&B fields merged into ``nnmodelling.toml``."""

    model_config = ConfigDict(extra="forbid")

    entity: str | None = None
    project: str | None = None
    tags: list[str] | None = None
    run_name_template: str | None = None
    mode: Literal["online", "offline", "disabled"] | None = None


class WandbSettingsResponse(WandbSettings):
    """Redacted W&B settings: the API key is never returned."""

    api_key_configured: bool = False


class WandbKeyInput(BaseModel):
    """Body of ``PUT /projects/{id}/wandb-key``."""

    model_config = ConfigDict(extra="forbid")

    api_key: str

    @field_validator("api_key")
    @classmethod
    def api_key_is_plain_text(cls, value: str) -> str:
        """Reject keys carrying control characters or line breaks."""
        if not value or len(value) > WANDB_KEY_MAX_LENGTH:
            raise ValueError("api_key must be a non-empty string of at most 200 characters")
        return value


class WandbKeyStatus(BaseModel):
    """Confirmation returned after storing or removing a W&B API key."""

    configured: bool


class StereotypeCatalogEntry(BaseModel):
    """Stable wire form for one stereotype: catalog path plus raw definition.

    ``id`` is the catalog-relative path used by the editor's ``StereotypeCore``
    as its file path (built-ins keep the ``Stereotypes/...`` layout so the
    ``/Joins/`` and ``/SubFlows/`` path conventions are preserved), ``source``
    distinguishes repository built-ins from project-local definitions, and
    ``data`` carries the complete JSON definition.
    """

    id: str
    name: str
    source: Literal["builtin", "project"]
    data: dict[str, Any]


class StereotypeCatalogResponse(BaseModel):
    """Built-in plus validated project stereotypes and diagnostics.

    Malformed definitions and name collisions with built-ins are reported in
    ``errors`` with the offending file path; colliding project stereotypes are
    excluded from ``stereotypes`` while the built-in definition wins.
    """

    stereotypes: list[StereotypeCatalogEntry] = Field(default_factory=list)
    errors: list[dict[str, str]] = Field(default_factory=list)


class DatasetCatalogError(BaseModel):
    """One project dataset module that failed to import or validate."""

    path: str
    error: str


class DatasetCatalogResponse(BaseModel):
    """Built-in plus validated project datasets and per-module diagnostics."""

    datasets: list[DatasetInfo] = Field(default_factory=list)
    errors: list[DatasetCatalogError] = Field(default_factory=list)
