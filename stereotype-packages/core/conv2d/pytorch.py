import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


def build(parameters: dict, context: BuildContext, services: NoServices) -> torch.nn.Module:
    del context, services
    return torch.nn.Conv2d(
        in_channels=parameters["in_channels"],
        out_channels=parameters["out_channels"],
        kernel_size=parameters["kernel_size"],
        stride=parameters.get("stride", 1),
        padding=parameters.get("padding", 0),
        dilation=parameters.get("dilation", 1),
        groups=parameters.get("groups", 1),
        bias=parameters.get("bias", True),
    )
