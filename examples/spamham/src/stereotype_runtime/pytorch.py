"""Compatibility re-export for generated package entrypoints."""

from nnm_spamham.stereotype_runtime.pytorch import (
    BuildContext,
    DType,
    NoServices,
    StereotypeReference,
    StereotypeServices,
    SubflowServices,
    torch_dtype,
)

__all__ = [
    "BuildContext",
    "DType",
    "NoServices",
    "StereotypeReference",
    "StereotypeServices",
    "SubflowServices",
    "torch_dtype",
]
