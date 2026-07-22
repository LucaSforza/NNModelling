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
import torch.nn as nn

from ops.subflow import Subflow


class Repeat(nn.Module):
    """Repeats subgraph N times with independent module instances.

    Creates N independent Subflow instances chained in nn.Sequential.
    Each instance gets fresh modules (Hydra instantiate creates new objects).
    """

    def __init__(self, entry_node: str, internal_nodes: dict, iterations: int = 1, **kwargs):
        super().__init__()
        self.net = nn.Sequential(*[
            Subflow(entry_node=entry_node, internal_nodes=internal_nodes)
            for _ in range(iterations)
        ])

    def forward(self, x):
        return self.net(x)

    def set_observer(self, callback) -> None:
        """Propagate the passive source sink to every repeated execution."""
        for subflow in self.net:
            subflow.set_observer(callback)
