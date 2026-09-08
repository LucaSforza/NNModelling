from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


class Parameters(TypedDict):
    epsilon_scale: float


class Reparameterize(torch.nn.Module):
    def __init__(self, epsilon_scale: float) -> None:
        super().__init__()
        self.epsilon_scale = epsilon_scale

    def forward(self, packed: torch.Tensor) -> torch.Tensor:
        mean, log_variance = torch.chunk(packed, 2, dim=-1)
        if not self.training:
            return mean
        return self.sample(packed)

    def sample(self, packed: torch.Tensor) -> torch.Tensor:
        """Explicit stochastic capability exposed to the installed wheel."""
        mean, log_variance = torch.chunk(packed, 2, dim=-1)
        standard_deviation = torch.exp(0.5 * log_variance)
        epsilon = torch.randn_like(standard_deviation)
        return mean + self.epsilon_scale * standard_deviation * epsilon


def build(
    parameters: Parameters,
    context: BuildContext,
    services: NoServices,
) -> torch.nn.Module:
    return Reparameterize(parameters["epsilon_scale"])
