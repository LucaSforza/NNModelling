from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


class Parameters(TypedDict):
    pass


class KLDivergence(torch.nn.Module):
    def forward(self, packed: torch.Tensor) -> torch.Tensor:
        mean, log_variance = torch.chunk(packed, 2, dim=-1)
        per_sample = -0.5 * (
            1 + log_variance - mean.square() - log_variance.exp()
        ).sum(dim=-1)
        return per_sample.mean()


def build(
    parameters: Parameters,
    context: BuildContext,
    services: NoServices,
) -> torch.nn.Module:
    return KLDivergence()
