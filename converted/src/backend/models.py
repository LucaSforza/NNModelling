"""Typed public models for the package-training API."""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


GPU_TYPE_SELECTOR = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")
NODE_SELECTOR = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.\-,\[\]]*")
PACKAGE_NAME = re.compile(r"nnm_[A-Za-z][A-Za-z0-9_]*\Z")


class NetworkPayload(BaseModel):
    """The package graph and immutable bundle reference for a job."""

    model_config = ConfigDict(extra="forbid")

    format: Literal["package"] = "package"
    value: dict[str, Any]

    @field_validator("value")
    @classmethod
    def validate_network_value(cls, value: dict[str, Any], info: Any) -> dict[str, Any]:
        """Require the minimal shape of the selected transport format."""

        has_bundle_ref = isinstance(value.get("bundle_ref"), str) and bool(value["bundle_ref"])
        if not isinstance(value.get("graph"), dict) or not has_bundle_ref:
            raise ValueError("package network requires graph plus bundle_ref")
        return value


class PackageUpload(BaseModel):
    """Package bundle uploaded by an authenticated browser connection."""

    model_config = ConfigDict(extra="forbid")

    bundle: dict[str, Any]
    sha256: str | None = Field(default=None, min_length=64, max_length=64)

    @field_validator("sha256")
    @classmethod
    def validate_sha256(cls, value: str | None) -> str | None:
        """Reject malformed declared digests before storage is attempted."""

        if value is not None and not re.fullmatch(r"[0-9a-fA-F]{64}", value):
            raise ValueError("sha256 must be a hexadecimal SHA-256 digest")
        return value


class PackageInfo(BaseModel):
    """Public digest-addressed package metadata."""

    id: str
    version: str
    sha256: str


class PackageBundleInfo(BaseModel):
    """Digest-addressed graph bundle stored for one browser connection."""

    bundle_ref: str
    digest: str
    size: int = Field(ge=0)


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


class DatasetRequest(BaseModel):
    """Dataset constructor and bounded split configuration."""

    model_config = ConfigDict(extra="forbid")

    target: str = Field(min_length=1, max_length=240)
    parameters: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_registered_parameters(self) -> "DatasetRequest":
        from backend.dataset_registry import validate_dataset_parameters

        self.parameters = validate_dataset_parameters(self.target, self.parameters)
        return self


class OptimizerRequest(BaseModel):
    """Optimizer target and learning rate understood by the worker."""

    model_config = ConfigDict(extra="forbid")

    target: str = Field(default="torch.optim.Adam", min_length=1, max_length=240)
    learning_rate: float = Field(default=0.001, gt=0, allow_inf_nan=False)


class TrainerRequest(BaseModel):
    """Training controls exposed by the UI."""

    model_config = ConfigDict(extra="forbid")

    max_epochs: int = Field(default=20, ge=1, le=100_000)
    accelerator: Literal["auto", "cpu", "cuda"] = "auto"
    patience: int = Field(default=3, ge=0, le=100_000)
    min_delta: float = Field(default=0.0, ge=0, allow_inf_nan=False)


class WandbRequest(BaseModel):
    """Explicitly configured experiment logging mode."""

    model_config = ConfigDict(extra="forbid")

    project: str = Field(default="NeuralNetworks", max_length=200)
    mode: Literal["disabled", "offline", "online"] = "disabled"


class TrainingRequest(BaseModel):
    """Complete, validated training contract sent by the frontend."""

    model_config = ConfigDict(extra="forbid")

    dataset: DatasetRequest
    seed: int = Field(default=0, ge=0, le=2**63 - 1)
    optimizer: OptimizerRequest = Field(default_factory=OptimizerRequest)
    trainer: TrainerRequest = Field(default_factory=TrainerRequest)
    wandb: WandbRequest = Field(default_factory=WandbRequest)


class JobSubmission(BaseModel):
    """Complete request submitted to the training backend."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(default=1, ge=1)
    network: NetworkPayload
    training: TrainingRequest
    resources: ResourceRequest = Field(default_factory=ResourceRequest)
    priority: int = Field(default=0, ge=0, le=1_000_000)
    package_name: str | None = Field(default=None, max_length=100)

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
