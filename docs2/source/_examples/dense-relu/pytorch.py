"""PyTorch implementation of the tutorial Dense ReLU stereotype."""

from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


class Parameters(TypedDict):
    """Validated node settings; these are not learned weights."""

    in_features: int
    out_features: int
    bias: bool


def build(
    parameters: Parameters,
    context: BuildContext,
    services: NoServices,
) -> torch.nn.Module:
    """Construct one trainable module for this graph node."""
    del context, services
    return torch.nn.Sequential(
        torch.nn.Linear(
            parameters["in_features"],
            parameters["out_features"],
            bias=parameters.get("bias", True),
            dtype=torch.float32,
        ),
        torch.nn.ReLU(),
    )
