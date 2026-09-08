from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


class Parameters(TypedDict, total=False):
    dim0: int
    dim1: int


class Transpose(torch.nn.Module):
    """Swap two dimensions while preserving all other dimensions."""

    def __init__(self, dim0: int, dim1: int) -> None:
        super().__init__()
        self.dim0 = dim0
        self.dim1 = dim1

    def forward(self, input: torch.Tensor) -> torch.Tensor:
        return torch.transpose(input, self.dim0, self.dim1)


def build(
    parameters: Parameters,
    context: BuildContext,
    services: NoServices,
) -> torch.nn.Module:
    del context, services
    return Transpose(parameters.get("dim0", -2), parameters.get("dim1", -1))
