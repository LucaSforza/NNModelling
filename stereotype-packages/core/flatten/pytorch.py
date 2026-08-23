from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


class Parameters(TypedDict):
    start_dim: int
    end_dim: int


def build(
    parameters: Parameters,
    context: BuildContext,
    services: NoServices,
) -> torch.nn.Module:
    del context, services
    return torch.nn.Flatten(
        start_dim=parameters["start_dim"],
        end_dim=parameters["end_dim"],
    )
