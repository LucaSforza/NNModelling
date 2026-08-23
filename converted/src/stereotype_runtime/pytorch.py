"""Small, stable service protocol for package PyTorch builders.

The runtime deliberately contains protocols and data contracts only. Package
code is loaded by :mod:`package_runtime`, which supplies the concrete services.
"""

from __future__ import annotations

from typing import Any, Literal, Protocol, TypedDict

import torch


DType = Literal["float16", "bfloat16", "float32", "float64"]


class StereotypeReference(TypedDict):
    """Reference to another package used by a composite stereotype."""

    id: str
    version: str
    parameters: dict[str, Any]


class BuildContext(TypedDict, total=False):
    """Context available while constructing one graph node."""

    node_id: str
    package_id: str
    parameters: dict[str, Any]
    inputs: int
    output: dict[str, Any]


class NoServices:
    """Marker service type for builders that do not need graph services."""


class SubflowServices(Protocol):
    """Services available to a stereotype that owns a nested graph."""

    def build_subflow(self) -> torch.nn.Module:
        """Build one independent instance of the current nested graph."""


class StereotypeServices(Protocol):
    """Services available to a stereotype that references another package."""

    def build_stereotype(
        self,
        reference: StereotypeReference,
        context: BuildContext | None = None,
    ) -> torch.nn.Module:
        """Build a referenced package under the current dependency closure."""


def torch_dtype(dtype: DType) -> torch.dtype:
    """Map the package dtype spelling to a PyTorch dtype."""

    try:
        return {
            "float16": torch.float16,
            "bfloat16": torch.bfloat16,
            "float32": torch.float32,
            "float64": torch.float64,
        }[dtype]
    except KeyError as exc:
        raise ValueError(f"unsupported dtype: {dtype}") from exc
