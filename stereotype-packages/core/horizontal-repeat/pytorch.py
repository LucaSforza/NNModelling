from typing import Protocol, TypedDict

import torch
from torch import nn
from torch.func import functional_call, stack_module_state, vmap

import copy

from stereotype_runtime.pytorch import (
    BuildContext,
    StereotypeReference,
    StereotypeServices,
    SubflowServices,
)


class Parameters(TypedDict):
    times: int
    join: StereotypeReference


class Services(SubflowServices, StereotypeServices, Protocol):
    pass


class HorizontalRepeat(nn.Module):
    def __init__(
        self,
        subflows: list[nn.Module],
        join: nn.Module,
    ) -> None:
        super().__init__()

        if not subflows:
            raise ValueError("HorizontalRepeat requires at least one subflow")

        self.count = len(subflows)
        self.join = join

        # All subflows have the same structure but independent parameters.
        params, buffers = stack_module_state(subflows)

        # Structure-only module used by functional_call.
        base = copy.deepcopy(subflows[0]).to("meta")
        object.__setattr__(self, "_base", base)

        # Keep original parameter/buffer names for functional_call.
        self._param_names = tuple(params)
        self._buffer_names = tuple(buffers)

        # The STACKED tensors are the actual trainable state of this module.
        for i, param in enumerate(params.values()):
            self.register_parameter(f"_stacked_param_{i}", param)

        for i, buffer in enumerate(buffers.values()):
            self.register_buffer(f"_stacked_buffer_{i}", buffer)

    def _params(self) -> dict[str, torch.Tensor]:
        return {
            name: getattr(self, f"_stacked_param_{i}")
            for i, name in enumerate(self._param_names)
        }

    def _buffers(self) -> dict[str, torch.Tensor]:
        return {
            name: getattr(self, f"_stacked_buffer_{i}")
            for i, name in enumerate(self._buffer_names)
        }

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        params = self._params()
        buffers = self._buffers()

        def forward_single(p, b, x):
            return functional_call(
                self._base,
                (p, b),
                (x,),
            )

        outputs = vmap(
            forward_single,
            in_dims=(0, 0, None),
            randomness="different",
        )(params, buffers, x)

        # outputs:
        # [repeat, batch, ...]

        return self.join(*outputs.unbind(0))


def build(
    parameters: Parameters,
    context: BuildContext,
    services: Services,
) -> torch.nn.Module:
    return HorizontalRepeat(
        [services.build_subflow() for _ in range(parameters["times"])],
        services.build_stereotype(parameters["join"]),
    )
