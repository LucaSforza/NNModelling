"""Versioned, declarative contracts shared by built-in and project datasets."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import json
from pathlib import Path
from typing import Literal, Protocol

import torch
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr, field_validator, model_validator


DATASET_SCHEMA_VERSION = 1
MODEL_MANIFEST_SCHEMA_VERSION = 2
_ID = r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$"
_SLOT = r"^[A-Za-z_][A-Za-z0-9_]*$"
_VERSION = r"^(?:0|[1-9][0-9]*)\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"
_PARAMETER_TYPES = {"string", "integer", "number", "boolean"}
_DTYPES = {"float16", "bfloat16", "float32", "float64", "int8", "uint8", "int16", "int32", "int64", "bool"}


class DatasetContractError(ValueError):
    """Stable validation error that can cross the API/worker boundary."""

    def __init__(self, message: str, code: str, path: str | None = None) -> None:
        self.code = code
        self.path = path
        super().__init__(f"{code}{f' at {path}' if path else ''}: {message}")


class ModelDatasetReference(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(pattern=_ID)
    version: str = Field(pattern=_VERSION)
    path: str = Field(min_length=1)

    @field_validator("path")
    @classmethod
    def confined_path(cls, value: str) -> str:
        path = value.replace("\\", "/")
        segments = path.split("/")
        if path.startswith("/") or ":/" in path[:3] or "\x00" in path or any(segment in {"", ".", ".."} for segment in segments):
            raise DatasetContractError("must be a confined relative path", "invalid-path", "path")
        return path


class ModelPackageReference(ModelDatasetReference):
    """Package references have the same confined identity/path shape."""


class ModelManifestV2(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schemaVersion: Literal[2] = 2
    id: str = Field(pattern=_ID)
    version: str = Field(pattern=_VERSION)
    name: str = Field(min_length=1)
    description: str | None = None
    customPackages: tuple[ModelPackageReference, ...] = ()
    customDatasets: tuple[ModelDatasetReference, ...] = ()

    @model_validator(mode="after")
    def unique_entries(self) -> "ModelManifestV2":
        _unique_references(self.customPackages, "customPackages")
        _unique_references(self.customDatasets, "customDatasets")
        return self


class DatasetParameter(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(pattern=_SLOT)
    type: str
    required: bool = False
    default: StrictStr | StrictInt | StrictFloat | StrictBool | None = None

    @field_validator("type")
    @classmethod
    def supported_type(cls, value: str) -> str:
        if value not in _PARAMETER_TYPES:
            raise DatasetContractError("parameter type is unsupported", "invalid-parameter", "type")
        return value

    @model_validator(mode="after")
    def valid_default(self) -> "DatasetParameter":
        if self.required and self.default is not None:
            raise DatasetContractError("required parameters cannot have a default", "invalid-parameter", self.name)
        if self.default is not None:
            valid = (
                self.type == "string" and isinstance(self.default, str)
                or self.type == "integer" and isinstance(self.default, int) and not isinstance(self.default, bool)
                or self.type == "number" and isinstance(self.default, (int, float)) and not isinstance(self.default, bool)
                or self.type == "boolean" and isinstance(self.default, bool)
            )
            if not valid:
                raise DatasetContractError("default does not match parameter type", "invalid-parameter", self.name)
        return self


class TensorSlotContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    shape: tuple[str | int, ...]
    dtype: str

    @field_validator("shape")
    @classmethod
    def valid_shape(cls, value: tuple[str | int, ...]) -> tuple[str | int, ...]:
        if any((isinstance(item, int) and (isinstance(item, bool) or item <= 0)) or (isinstance(item, str) and not item.isidentifier()) for item in value):
            raise DatasetContractError("shape contains an invalid dimension", "invalid-slot", "shape")
        return value

    @field_validator("dtype")
    @classmethod
    def supported_dtype(cls, value: str) -> str:
        if value not in _DTYPES:
            raise DatasetContractError("dtype is unsupported", "unsupported-dtype", "dtype")
        return value


class DatasetBatchContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    inputs: dict[str, TensorSlotContract] = {}
    targets: dict[str, TensorSlotContract] = {}

    @model_validator(mode="after")
    def unique_slot_names(self) -> "DatasetBatchContract":
        overlap = sorted(set(self.inputs).intersection(self.targets))
        if overlap:
            raise DatasetContractError(f"duplicate slot(s): {', '.join(overlap)}", "duplicate-entry", "batch")
        for group, slots in (("inputs", self.inputs), ("targets", self.targets)):
            for name in slots:
                if not __import__("re").fullmatch(_SLOT, name):
                    raise DatasetContractError("slot name is invalid", "invalid-slot", f"batch.{group}.{name}")
        return self


class DatasetClassMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    count: int = Field(gt=0)
    names: tuple[str, ...] | None = None

    @model_validator(mode="after")
    def matching_names(self) -> "DatasetClassMetadata":
        if self.names is not None and len(self.names) != self.count:
            raise DatasetContractError("names must contain one label per class", "invalid-parameter", "classes.names")
        return self


class DatasetDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schemaVersion: Literal[1] = 1
    id: str = Field(pattern=_ID)
    version: str = Field(pattern=_VERSION)
    name: str = Field(min_length=1)
    description: str | None = None
    parameters: tuple[DatasetParameter, ...] = ()
    batch: DatasetBatchContract
    classes: DatasetClassMetadata | None = None
    inferenceAdapter: dict[str, object] | None = None

    @model_validator(mode="after")
    def unique_parameters(self) -> "DatasetDefinition":
        names = [item.name for item in self.parameters]
        if len(names) != len(set(names)):
            raise DatasetContractError("parameter names must be unique", "duplicate-entry", "parameters")
        return self


class DatasetSourceManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schemaVersion: Literal[1] = 1
    id: str = Field(pattern=_ID)
    version: str = Field(pattern=_VERSION)
    entrypoints: dict[str, Literal["dataset.json", "dataset.py"]]

    @model_validator(mode="after")
    def fixed_entrypoints(self) -> "DatasetSourceManifest":
        if self.entrypoints != {"definition": "dataset.json", "python": "dataset.py"}:
            raise DatasetContractError("entrypoints must be dataset.json and dataset.py", "invalid-path", "entrypoints")
        return self


class DatasetReference(BaseModel):
    """Opaque resolved reference; it is not a Python target or filesystem path."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["builtin", "project"]
    id: str = Field(pattern=_ID)
    version: str = Field(pattern=_VERSION)
    ref: str = Field(min_length=1)
    digest: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{64}$")

    @field_validator("ref")
    @classmethod
    def opaque_ref(cls, value: str) -> str:
        if "/" in value or "\\" in value or value.startswith("."):
            raise DatasetContractError("ref must be opaque and not a path", "invalid-reference", "ref")
        return value

    @model_validator(mode="after")
    def project_digest(self) -> "DatasetReference":
        if self.kind == "project" and self.digest is None:
            raise DatasetContractError("project references require a digest", "invalid-reference", "digest")
        return self


@dataclass(frozen=True)
class DatasetContext:
    """Read-only resource capability passed to a dataset builder in the worker."""

    resource_root: Path
    reference: DatasetReference | None = None


@dataclass(frozen=True)
class TrainingBatch:
    """Normalized flat named tensor maps crossing the worker boundary."""

    inputs: Mapping[str, torch.Tensor]
    targets: Mapping[str, torch.Tensor]

    def __post_init__(self) -> None:
        _validate_tensor_map(self.inputs, "inputs")
        _validate_tensor_map(self.targets, "targets")
        overlap = set(self.inputs).intersection(self.targets)
        if overlap:
            raise DatasetContractError(f"duplicate slot(s): {', '.join(sorted(overlap))}", "duplicate-entry", "batch")

    def to(self, device: torch.device | str) -> "TrainingBatch":
        return TrainingBatch(
            inputs={name: tensor.to(device) for name, tensor in self.inputs.items()},
            targets={name: tensor.to(device) for name, tensor in self.targets.items()},
        )


class DatasetBuilder(Protocol):
    def build(self, parameters: Mapping[str, object], context: DatasetContext) -> object:
        """Build a dataset whose loader items are normalized TrainingBatch values."""


def normalize_training_batch(value: object) -> TrainingBatch:
    """Validate a loader item without accepting nested or positional batches."""

    if isinstance(value, TrainingBatch):
        return value
    if not isinstance(value, Mapping):
        raise DatasetContractError("batch must be an object with inputs and targets maps", "invalid-slot", "batch")
    keys = set(value)
    if keys != {"inputs", "targets"}:
        raise DatasetContractError("batch must contain exactly inputs and targets", "invalid-slot", "batch")
    inputs = value["inputs"]
    targets = value["targets"]
    if not isinstance(inputs, Mapping) or not isinstance(targets, Mapping):
        raise DatasetContractError("inputs and targets must be flat maps", "invalid-slot", "batch")
    return TrainingBatch(inputs=inputs, targets=targets)


def parse_model_manifest(value: object) -> tuple[ModelManifestV2, bool]:
    """Read v1 and v2 source manifests, returning whether v1 was upgraded."""

    if not isinstance(value, Mapping):
        raise DatasetContractError("model manifest must be an object", "invalid-identity", "manifest")
    schema_version = value.get("schemaVersion")
    if schema_version == 1:
        legacy = {key: item for key, item in value.items() if key != "schemaVersion"}
        legacy["schemaVersion"] = MODEL_MANIFEST_SCHEMA_VERSION
        legacy.setdefault("customDatasets", [])
        return ModelManifestV2.model_validate(legacy), True
    if schema_version == MODEL_MANIFEST_SCHEMA_VERSION:
        return ModelManifestV2.model_validate(value), False
    raise DatasetContractError("model manifest schemaVersion is unsupported", "unknown-version", "schemaVersion")


def serialize_dataset_definition(value: DatasetDefinition) -> str:
    """Serialize the canonical JSON form shared with the browser validator."""

    return json.dumps(value.model_dump(mode="json", exclude_none=True), sort_keys=True, separators=(",", ":"))


def _validate_tensor_map(value: Mapping[str, torch.Tensor], group: str) -> None:
    if not isinstance(value, Mapping):
        raise DatasetContractError(f"{group} must be a flat map", "invalid-slot", f"batch.{group}")
    for name, tensor in value.items():
        if not isinstance(name, str) or not __import__("re").fullmatch(_SLOT, name):
            raise DatasetContractError("slot name is invalid", "invalid-slot", f"batch.{group}")
        if not isinstance(tensor, torch.Tensor):
            raise DatasetContractError("slot values must be tensors", "invalid-slot", f"batch.{group}.{name}")


def _unique_references(values: tuple[ModelDatasetReference, ...], label: str) -> None:
    identities = {(item.id, item.version) for item in values}
    paths = {item.path for item in values}
    if len(identities) != len(values) or len(paths) != len(values):
        raise DatasetContractError("identities and paths must be unique", "duplicate-entry", label)
