import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


def build(parameters: dict, context: BuildContext, services: NoServices) -> torch.nn.Module:
    del context, services
    return torch.nn.BatchNorm2d(
        num_features=parameters["num_features"],
        eps=parameters.get("eps", 1e-5),
        momentum=parameters.get("momentum", 0.1),
        affine=parameters.get("affine", True),
        track_running_stats=parameters.get("track_running_stats", True),
    )
