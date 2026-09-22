"""Readable model-owned layer scaffold. It is intentionally shape/dtype transparent."""

from collections.abc import Mapping

import torch

from stereotype_runtime.pytorch import BuildContext, NoServices

Parameters = Mapping[str, object]


def build(
    parameters: Parameters,
    context: BuildContext,
    services: NoServices,
) -> torch.nn.Module:
    """Build an identity module; runtime applies it without changing tensors."""
    del parameters, context, services
    return torch.nn.Identity()
