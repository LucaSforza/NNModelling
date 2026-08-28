import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


def build(parameters: dict[str, object], context: BuildContext, services: NoServices) -> torch.nn.Module:
    return torch.nn.Identity()
