from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, SubflowServices


class Parameters(TypedDict):
    times: int


class Repeat(torch.nn.Module):
    def __init__(self, subflows: list[torch.nn.Module]) -> None:
        super().__init__()
        self.subflows = torch.nn.ModuleList(subflows)

    def forward(self, input: torch.Tensor) -> torch.Tensor:
        output = input

        for subflow in self.subflows:
            output = subflow(output)

        return output


def build(
    parameters: Parameters,
    context: BuildContext,
    services: SubflowServices,
) -> torch.nn.Module:
    return Repeat([
        services.build_subflow()
        for _ in range(parameters["times"])
    ])
