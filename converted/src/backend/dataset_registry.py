"""Declarative registry for trusted built-in datasets.

The registry is intentionally explicit. FastAPI can publish descriptors
without importing a dataset class or inspecting a constructor; only the
worker-side builder resolves an opaque built-in reference to trusted code.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from dataset.autoencoder_mnist import (
    AUTOENCODER_MNIST_DATASET_ID,
    AUTOENCODER_MNIST_DATASET_REF,
    AUTOENCODER_MNIST_DATASET_VERSION,
    AUTOENCODER_MNIST_DEFINITION,
    AUTOENCODER_MNIST_MANIFEST,
    build as build_autoencoder_mnist,
    validate_parameters as validate_autoencoder_mnist_parameters,
)
from dataset.contracts import (
    DatasetContext,
    DatasetDefinition,
    DatasetReference,
    DatasetSourceManifest,
)
from dataset.enron_spam import (
    ENRON_SPAM_DATASET_ID,
    ENRON_SPAM_DATASET_REF,
    ENRON_SPAM_DATASET_VERSION,
    ENRON_SPAM_DEFINITION,
    ENRON_SPAM_MANIFEST,
    build as build_enron_spam,
    validate_parameters as validate_enron_spam_parameters,
)
from dataset.mnist import (
    MNIST_DATASET_ID,
    MNIST_DATASET_REF,
    MNIST_DATASET_VERSION,
    MNIST_DEFINITION,
    MNIST_MANIFEST,
    build as build_mnist,
    validate_parameters as validate_mnist_parameters,
)

from backend.models import DatasetInfo


Builder = Callable[[Mapping[str, Any], DatasetContext], Any]
Validator = Callable[[Mapping[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class BuiltinDatasetRegistration:
    """Trusted code paired with one immutable declarative descriptor."""

    reference: DatasetReference
    manifest: DatasetSourceManifest
    definition: DatasetDefinition
    builder: Builder
    validate_parameters: Validator


_BUILTINS = (
    BuiltinDatasetRegistration(
        reference=DatasetReference(
            kind="builtin", id=MNIST_DATASET_ID,
            version=MNIST_DATASET_VERSION, ref=MNIST_DATASET_REF,
        ),
        manifest=MNIST_MANIFEST,
        definition=MNIST_DEFINITION,
        builder=build_mnist,
        validate_parameters=validate_mnist_parameters,
    ),
    BuiltinDatasetRegistration(
        reference=DatasetReference(
            kind="builtin", id=AUTOENCODER_MNIST_DATASET_ID,
            version=AUTOENCODER_MNIST_DATASET_VERSION,
            ref=AUTOENCODER_MNIST_DATASET_REF,
        ),
        manifest=AUTOENCODER_MNIST_MANIFEST,
        definition=AUTOENCODER_MNIST_DEFINITION,
        builder=build_autoencoder_mnist,
        validate_parameters=validate_autoencoder_mnist_parameters,
    ),
    BuiltinDatasetRegistration(
        reference=DatasetReference(
            kind="builtin", id=ENRON_SPAM_DATASET_ID,
            version=ENRON_SPAM_DATASET_VERSION,
            ref=ENRON_SPAM_DATASET_REF,
        ),
        manifest=ENRON_SPAM_MANIFEST,
        definition=ENRON_SPAM_DEFINITION,
        builder=build_enron_spam,
        validate_parameters=validate_enron_spam_parameters,
    ),
)

_BY_REFERENCE = {
    (
        registration.reference.kind,
        registration.reference.id,
        registration.reference.version,
        registration.reference.ref,
    ): registration
    for registration in _BUILTINS
}


def discover_datasets() -> list[DatasetInfo]:
    """Return fixed descriptors without constructor introspection."""

    return [
        DatasetInfo(
            reference=registration.reference,
            manifest=registration.manifest,
            definition=registration.definition,
        )
        for registration in _BUILTINS
    ]


def resolve_dataset(reference: DatasetReference) -> BuiltinDatasetRegistration:
    """Resolve one exact opaque reference to trusted worker code."""

    registration = _BY_REFERENCE.get(
        (
            reference.kind,
            reference.id,
            reference.version,
            reference.ref,
        )
    )
    if registration is None:
        if reference.kind == "project":
            raise ValueError("project dataset references are not available to the built-in registry")
        raise ValueError(f"dataset reference is not registered: {reference.id}@{reference.version}")
    return registration


def validate_dataset_parameters(
    reference: DatasetReference,
    raw: Mapping[str, Any],
) -> dict[str, Any]:
    """Validate typed values against a descriptor-owned parameter schema."""

    if not isinstance(raw, Mapping):
        raise ValueError("dataset parameters must be an object")
    registration = resolve_dataset(reference)
    names = {parameter.name for parameter in registration.definition.parameters}
    unknown = sorted(set(raw) - names)
    if unknown:
        raise ValueError(f"unknown dataset parameter(s): {', '.join(unknown)}")
    normalized: dict[str, Any] = {}
    for parameter in registration.definition.parameters:
        if parameter.name in raw:
            normalized[parameter.name] = _coerce_parameter(
                parameter.name, parameter.type, raw[parameter.name]
            )
    return registration.validate_parameters(normalized)


def build_dataset(
    reference: DatasetReference,
    parameters: Mapping[str, Any],
    context: DatasetContext,
) -> Any:
    """Build a trusted dataset using the fixed builder/context interface."""

    registration = resolve_dataset(reference)
    normalized = validate_dataset_parameters(reference, parameters)
    return registration.builder(normalized, context)


def _coerce_parameter(name: str, kind: str, value: Any) -> Any:
    """Canonicalize scalar input without relying on a Python signature."""

    if kind == "string":
        if not isinstance(value, str):
            raise ValueError(f"invalid dataset parameter {name}")
        return value
    if kind == "integer":
        if isinstance(value, bool):
            raise ValueError(f"invalid dataset parameter {name}")
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.strip().lstrip("-").isdigit():
            return int(value)
        raise ValueError(f"invalid dataset parameter {name}")
    if kind == "number":
        if isinstance(value, bool):
            raise ValueError(f"invalid dataset parameter {name}")
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value)
            except ValueError:
                pass
        raise ValueError(f"invalid dataset parameter {name}")
    if kind == "boolean":
        if isinstance(value, bool):
            return value
        raise ValueError(f"invalid dataset parameter {name}")
    raise ValueError(f"unsupported dataset parameter type: {kind}")


def builtin_reference(dataset_id: str) -> DatasetReference:
    """Return the exact opaque reference for a built-in identity."""

    for registration in _BUILTINS:
        if registration.reference.id == dataset_id:
            return registration.reference
    raise ValueError(f"dataset id is not registered: {dataset_id}")
