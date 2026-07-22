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
from hydra.utils import instantiate
from omegaconf import DictConfig, OmegaConf


class Subflow(nn.Module):
    """Executes internal graph via BFS topological sort.

    Receives entry_node + internal_nodes from Hydra with _recursive_: false,
    so internal_nodes is a raw DictConfig. Subflow manually instantiates
    each internal node's module and manages the DAG execution.

    Join inputs are ordered by edge targetHandle ("in-0", "in-1", ...)
    preserved from the diagram via the ``inputs`` config field, not by
    BFS traversal order. This ensures non-commutative joins (MatMul,
    ScaledDotProduct, etc.) receive correct argument order.
    """

    def __init__(self, entry_node: str, internal_nodes: dict, **kwargs):
        super().__init__()
        self.entry_node = entry_node
        self.internal_nodes = internal_nodes
        self.module_dict = nn.ModuleDict()
        self.input_order: dict[str, list[str]] = {}
        self._observer = None

        for node_id, cfg in internal_nodes.items():
            if isinstance(cfg, DictConfig):
                layer_dict = OmegaConf.to_container(cfg, resolve=True)
            else:
                layer_dict = dict(cfg)
            layer_dict.pop("stereotype", None)
            layer_dict.pop("taskType", None)
            layer_dict.pop("children", None)
            layer_dict.pop("type", None)
            layer_dict.pop("moduleId", None)
            inputs_list = layer_dict.pop("inputs", None)
            if inputs_list:
                self.input_order[node_id] = inputs_list
            if "_target_" in layer_dict:
                self.module_dict[node_id] = instantiate(layer_dict)

        self.in_degrees: dict[str, int] = {}
        for node_id in internal_nodes:
            self.in_degrees[node_id] = 0
        for node_id, cfg in internal_nodes.items():
            children = cfg.get("children", []) if isinstance(cfg, dict) else cfg.get("children", [])
            for child_id in children:
                self.in_degrees[child_id] = self.in_degrees.get(child_id, 0) + 1

    def forward(self, x):
        # node_inputs[target_id] = {source_id: tensor} — dict so we can
        # reorder join inputs by handle instead of BFS arrival order.
        node_inputs: dict[str, dict] = {self.entry_node: {"_in": x}}
        processed: dict[str, int] = {n: 0 for n in self.in_degrees}
        queue = [self.entry_node]
        final = x

        while queue:
            curr = queue.pop(0)

            if curr not in self.internal_nodes:
                continue

            cfg = self.internal_nodes[curr]
            node_type = cfg.get("type", "") if isinstance(cfg, dict) else cfg.type
            children = cfg.get("children", []) if isinstance(cfg, dict) else cfg.get("children", [])

            inputs = node_inputs.get(curr, {"_in": x})

            if node_type == "join":
                if curr in self.input_order:
                    ordered = [inputs.get(pid) for pid in self.input_order[curr]]
                    ordered = [t for t in ordered if t is not None]
                else:
                    ordered = list(inputs.values())
                out = self.module_dict[curr](ordered) if curr in self.module_dict else ordered[0]
            else:
                inp = next(iter(inputs.values()))
                out = self.module_dict[curr](inp) if curr in self.module_dict else inp

            if curr not in self.module_dict and self._observer is not None:
                self._observer(curr, out)

            final = out

            for child_id in children:
                if child_id not in node_inputs:
                    node_inputs[child_id] = {}
                node_inputs[child_id][curr] = out
                processed[child_id] = processed.get(child_id, 0) + 1
                if processed[child_id] == self.in_degrees.get(child_id, 1):
                    queue.append(child_id)

        return final

    def set_observer(self, callback) -> None:
        """Install a transient passive sink for internal Input/Fork outputs."""
        self._observer = callback

    def __getstate__(self):
        state = self.__dict__.copy()
        state["_observer"] = None
        return state
