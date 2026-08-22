from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, DType, NoServices, torch_dtype


class Parameters(TypedDict):
    dtype: DType


class Cast(torch.nn.Module):
    def __init__(self, dtype: torch.dtype) -> None:
        super().__init__()
        self.dtype = dtype

    def forward(self, input: torch.Tensor) -> torch.Tensor:
        return input.to(dtype=self.dtype)


def build(
    parameters: Parameters,
    context: BuildContext,
    services: NoServices,
) -> torch.nn.Module:
    return Cast(torch_dtype(context["output"]["dtype"]))
