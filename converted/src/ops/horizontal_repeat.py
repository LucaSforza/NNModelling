# NNModelling — DSL for designing neural networks via visual node editor
# Copyright (C) 2026  Luca Sforza
#
# Licensed under the GNU General Public License v3 or later.
# Commercial licenses are available — contact Luca Sforza.
# See the LICENSE file for details.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
import torch
import torch.nn as nn
from torch.func import vmap, functional_call, stack_module_state

from ops.subflow import Subflow


class HorizontalRepeat(nn.Module):
    """Runs N parallel copies of subgraph on same input via vmap.

    Creates N independent Subflow instances with fresh modules.
    Forward uses vmap + functional_call for batched parallel execution.

    Join is hardcoded to **concat on dim=-1**: head outputs are stacked,
    moved to last position, and flattened. Output shape: [batch, ..., n * d_head].

    To use a different join (add, mean, max, etc.), modify forward() or create
    a new op — HorizontalRepeat does not expose join_type as a parameter.
    """

    def __init__(self, entry_node: str, internal_nodes: dict, n: int = 1, **kwargs):
        super().__init__()
        if n < 1:
            raise ValueError(f"HorizontalRepeat n must be >= 1, got {n}")

        self.n = n
        self.heads = nn.ModuleList([
            Subflow(entry_node=entry_node, internal_nodes=internal_nodes)
            for _ in range(n)
        ])
        # Reference module on meta device for functional_call.
        # Stored as plain attribute (not registered submodule) so Lightning/.to()
        # won't try to move meta tensors — base is structure-only, no real weights.
        _base = Subflow(entry_node=entry_node, internal_nodes=internal_nodes)
        _base.to("meta")
        object.__setattr__(self, "base", _base)
        self._observer = None

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self.n == 1:
            return self.heads[0](x)

        if self._observer is not None:
            # torch.func's functional_call/vmap path does not run hooks on the
            # real heads.  Use the same independent heads only while an
            # observer is attached so every public/internal source remains
            # observable without changing the disabled fast path.
            return torch.cat([head(x) for head in self.heads], dim=-1)

        params, buffers = stack_module_state(list(self.heads))

        def forward_single(p, b, x):
            return functional_call(self.base, (p, b), x)

        out = vmap(forward_single, in_dims=(0, 0, None))(params, buffers, x)
        # out shape: [n, batch, ..., d_head]
        # Reshape to: [batch, ..., n * d_head]
        out = out.moveaxis(0, -2)
        out = out.reshape(*out.shape[:-2], -1)
        return out

    def set_observer(self, callback) -> None:
        """Enable passive explicit-head execution and propagate callbacks."""
        self._observer = callback
        for head in self.heads:
            head.set_observer(callback)
