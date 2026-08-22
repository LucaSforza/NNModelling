from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


class Parameters(TypedDict):
    pass


class Add(torch.nn.Module):
    def forward(self, *inputs: torch.Tensor) -> torch.Tensor:
        output = inputs[0]

        for value in inputs[1:]:
            output = output + value

        return output


def build(
    parameters: Parameters,
    context: BuildContext,
    services: NoServices,
) -> torch.nn.Module:
    return Add()
