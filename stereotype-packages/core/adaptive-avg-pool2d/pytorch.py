import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


def build(parameters: dict, context: BuildContext, services: NoServices) -> torch.nn.Module:
    del context, services
    return torch.nn.AdaptiveAvgPool2d(parameters["output_size"])
