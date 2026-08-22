from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, DType, NoServices, torch_dtype


class Parameters(TypedDict):
    in_features: int
    out_features: int
    bias: bool
    dtype: DType


def build(
    parameters: Parameters,
    context: BuildContext,
    services: NoServices,
) -> torch.nn.Module:
    return torch.nn.Linear(
        parameters["in_features"],
        parameters["out_features"],
        bias=parameters["bias"],
        dtype=torch_dtype(context["output"]["dtype"]),
    )
