import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


def build(parameters: dict, context: BuildContext, services: NoServices) -> torch.nn.Module:
    del context, services
    return torch.nn.MaxPool2d(
        kernel_size=parameters["kernel_size"],
        stride=parameters.get("stride", 1),
        padding=parameters.get("padding", 0),
        dilation=parameters.get("dilation", 1),
        ceil_mode=parameters.get("ceil_mode", False),
    )
