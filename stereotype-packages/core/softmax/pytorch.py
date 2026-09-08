from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


class Parameters(TypedDict):
    dim: int


def build(parameters: Parameters, context: BuildContext, services: NoServices) -> torch.nn.Module:
    del context, services
    return torch.nn.Softmax(dim=parameters["dim"])
