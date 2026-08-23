from typing import Any

import torch

from stereotype_runtime.pytorch import BuildContext, SubflowServices


def build(
    parameters: dict[str, Any],
    context: BuildContext,
    services: SubflowServices,
) -> torch.nn.Module:
    return services.build_subflow()
