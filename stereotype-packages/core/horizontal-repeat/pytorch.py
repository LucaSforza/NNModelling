from typing import Protocol, TypedDict

import torch

from stereotype_runtime.pytorch import (
    BuildContext,
    StereotypeReference,
    StereotypeServices,
    SubflowServices,
)


class Parameters(TypedDict):
    times: int
    join: StereotypeReference


class Services(SubflowServices, StereotypeServices, Protocol):
    pass


class HorizontalRepeat(torch.nn.Module):
    def __init__(
        self,
        subflows: list[torch.nn.Module],
        join: torch.nn.Module,
    ) -> None:
        super().__init__()
        self.subflows = torch.nn.ModuleList(subflows)
        self.join = join

    def forward(self, input: torch.Tensor) -> torch.Tensor:
        return self.join(*(subflow(input) for subflow in self.subflows))


def build(
    parameters: Parameters,
    context: BuildContext,
    services: Services,
) -> torch.nn.Module:
    return HorizontalRepeat(
        [
            services.build_subflow()
            for _ in range(parameters["times"])
        ],
        services.build_stereotype(parameters["join"]),
    )
