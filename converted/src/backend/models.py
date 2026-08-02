"""Pydantic models for the remote-training API."""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


GPU_TYPE_SELECTOR = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")
NODE_SELECTOR = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.\-,\[\]]*")
PACKAGE_NAME = re.compile(r"nnm_[A-Za-z][A-Za-z0-9_]*\Z")
PROJECT_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")


class NetworkPayload(BaseModel):
    """A compiled network included in a training job."""

    format: Literal["nntree"] = "nntree"
    value: dict[str, Any]


class ResourceRequest(BaseModel):
    """Resources requested by a job from a compute-unit profile."""

    cpu: int = Field(default=1, ge=0)
    memory_gb: float = Field(default=1, gt=0)
    gpu: int = Field(default=0, ge=0)
    gpu_memory_gb: float | None = Field(default=None, gt=0)
    gpu_type: str | None = None
    node: str | None = None

    @field_validator("gpu_type")
    @classmethod
    def empty_gpu_type_is_none(cls, value: str | None) -> str | None:
        """Normalize and validate a GPU selector used in ``#SBATCH``."""

        if not value:
            return None
        if not GPU_TYPE_SELECTOR.fullmatch(value):
            raise ValueError("gpu_type selector contains unsupported characters")
        return value

    @field_validator("node")
    @classmethod
    def empty_node_is_none(cls, value: str | None) -> str | None:
        """Normalize and validate a Slurm node-list selector."""

        if not value:
            return None
        if not NODE_SELECTOR.fullmatch(value):
            raise ValueError("node selector contains unsupported characters")
        return value


class JobSubmission(BaseModel):
    """Complete request submitted to the training backend."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(default=1, ge=1)
    network: NetworkPayload
    training: dict[str, Any]
    resources: ResourceRequest = Field(default_factory=ResourceRequest)
    priority: int = Field(default=0, ge=0, le=1_000_000)
    package_name: str | None = Field(default=None, max_length=100)
    project_id: str | None = Field(default=None, max_length=64)

    @field_validator("schema_version")
    @classmethod
    def only_supported_schema_version(cls, value: int) -> int:
        """Reject unsupported request schema versions explicitly.

        Only schema version 1 is defined; any other value must fail loudly
        instead of being persisted as if it were understood.
        """
        if value != 1:
            raise ValueError("schema_version must be 1; other versions are not supported")
        return value

    @field_validator("project_id")
    @classmethod
    def project_id_is_a_simple_identifier(cls, value: str | None) -> str | None:
        """Accept only registry-style project identifiers.

        The project manager resolves the identifier against its own recent
        registry; an identifier with path characters must fail loudly instead
        of being interpreted as a filesystem path anywhere downstream.
        """
        if value is None:
            return None
        if not PROJECT_ID.fullmatch(value):
            raise ValueError("project_id must use letters, digits, underscores, or hyphens")
        return value

    @field_validator("package_name")
    @classmethod
    def package_name_has_required_prefix(cls, value: str | None) -> str | None:
        """Accept Python-importable package names with the required prefix."""

        if value is None:
            return None
        if not PACKAGE_NAME.fullmatch(value):
            raise ValueError("package_name must match nnm_<name> using letters, digits, and underscores")
        return value


class DatasetParameter(BaseModel):
    """Metadata for one dataset constructor parameter."""

    name: str
    type: str
    default: Any = None
    required: bool = False


class DatasetInfo(BaseModel):
    """Discoverable dataset class and its constructor metadata."""

    target: str
    name: str
    doc: str = ""
    parameters: list[DatasetParameter] = Field(default_factory=list)
    num_classes: int | None = Field(default=None, ge=1)
    source: Literal["builtin", "project"] = "builtin"


class ComputeUnitInfo(BaseModel):
    """Public description of a configured compute-unit profile."""

    id: str
    kind: Literal["local", "slurm"]
    capacity: ResourceRequest
    enabled: bool = True


class ModelPackageInfo(BaseModel):
    """Portable inference wheel emitted by a completed training job."""

    schema_version: int
    package_name: str
    version: str
    wheel: str
    sha256: str
    input_adapter: dict[str, Any]


class JobStatus(BaseModel):
    """Public job metadata returned by the API."""

    id: str
    status: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    priority: int
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
    executor: str | None = None
    compute_unit: str | None = None
    error: str | None = None
    heartbeat_at: str | None = None
    wandb_url: str | None = None
    model_package: ModelPackageInfo | None = None
    package_error: str | None = None
    artifact_dir: str


class PairingRequestInput(BaseModel):
    """Optional browser metadata supplied when requesting a connection."""

    model_config = ConfigDict(extra="forbid")

    device_name: str | None = Field(default=None, max_length=80)


class PairingGrantResponse(BaseModel):
    """One-time connection credentials returned to the browser."""

    request_id: str
    connection_id: str
    token: str
    verification_code: str
    expires_at: str


class PairingStatusResponse(BaseModel):
    """Observable state of a browser pairing request."""

    request_id: str
    connection_id: str
    status: Literal["pending", "approved", "rejected", "expired"]
    verification_code: str
    expires_at: str
    session_expires_at: str | None = None


class SessionInfo(BaseModel):
    """Public metadata for the authenticated browser connection."""

    id: str
    device_name: str | None = None
    status: str
    created_at: str
    approved_at: str | None = None
    expires_at: str | None = None
    last_seen_at: str | None = None
    revoked_at: str | None = None


class PairingApprovalInput(BaseModel):
    """Optional lifetime override supplied by a backend administrator."""

    model_config = ConfigDict(extra="forbid")

    ttl: str | None = None
