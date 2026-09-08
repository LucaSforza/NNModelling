from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


class Parameters(TypedDict):
    normalized_shape: int
    eps: float
    elementwise_affine: bool


def build(
    parameters: Parameters,
    context: BuildContext,
    services: NoServices,
) -> torch.nn.Module:
    del context, services
    return torch.nn.LayerNorm(
        normalized_shape=parameters["normalized_shape"],
        eps=parameters.get("eps", 1e-5),
        elementwise_affine=parameters.get("elementwise_affine", True),
    )
