from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


class Parameters(TypedDict):
    factor: float


class Scale(torch.nn.Module):
    def __init__(self, factor: float) -> None:
        super().__init__()
        self.factor = factor

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        return value * self.factor


def build(parameters: Parameters, context: BuildContext, services: NoServices) -> torch.nn.Module:
    del context, services
    return Scale(parameters["factor"])
