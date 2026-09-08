"""Mean-pool the token axis of a transformer sequence."""

from typing import Mapping

import torch

from stereotype_runtime.pytorch import BuildContext, NoServices

Parameters = Mapping[str, object]


class TokenPool(torch.nn.Module):
    """Reduce a ``[batch, tokens, features]`` tensor to ``[batch, features]``."""

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        if inputs.ndim != 3:
            raise ValueError(
                f"TokenPool expects a rank-3 tensor, got rank {inputs.ndim}"
            )
        return inputs.mean(dim=1)


def build(
    parameters: Parameters,
    context: BuildContext,
    services: NoServices,
) -> torch.nn.Module:
    """Build the fixed mean-pooling module."""
    del parameters, context, services
    return TokenPool()
