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
from typing import Any
import json
import os
import argparse
from omegaconf import OmegaConf

import ast


def parse_params(params_dict: dict[str, Any]) -> dict[str, Any]:
    """Converte i parametri dal JSON in valori Python."""
    result: dict[str, Any] = {}
    for param_name, param_data in params_dict.items():
        val_str = param_data.get("value", "")

        if str(val_str).lower() in ["null", "undefined"]:
            continue

        if str(val_str).lower() in ["none", ""]:
            result[param_name] = None
            continue

        if str(val_str).lower() == "true":
            result[param_name] = True
            continue
        if str(val_str).lower() == "false":
            result[param_name] = False
            continue

        try:
            result[param_name] = ast.literal_eval(val_str)
        except (ValueError, SyntaxError):
            result[param_name] = val_str
    return result


def build_layer_config(layer_data: dict[str, Any]) -> dict[str, Any]:
    """Costruisce il dizionario compatibile con Hydra per l'instanziazione."""
    stereotype = layer_data.get("stereotype", "")
    config = {"stereotype": stereotype}
    # Visual identity is required for binding compacted sequential layers to
    # observation edges.  It is metadata, not a Hydra constructor argument.
    if layer_data.get("moduleId") is not None:
        config["moduleId"] = layer_data["moduleId"]

    if stereotype.lower() not in ("input", "fork"):
        python_class_name = layer_data.get("pythonClassName", stereotype)
        if python_class_name.startswith("nn."):
            config["_target_"] = "torch." + python_class_name
        elif python_class_name.startswith("torch."):
            config["_target_"] = python_class_name
        elif "." in python_class_name:
            config["_target_"] = python_class_name
        else:
            config["_target_"] = f"torch.nn.{python_class_name}"

    task_type = layer_data.get("taskType", "")
    if task_type:
        config["taskType"] = task_type

    config.update(parse_params(layer_data.get("params", {})))
    return config


def build_interpretability_config(nntree: dict[str, Any]) -> dict[str, Any]:
    """Translate the additive NNTree interpretability section for Hydra.

    Observable definitions intentionally remain outside ``net.nodes``.  The
    compiler does not invent defaults for a missing section: an absent section
    becomes an explicitly disabled runtime group.
    """
    section = nntree.get("interpretability") or {}
    observables: dict[str, Any] = {}
    for observable_id, raw in (section.get("observables") or {}).items():
        cfg = dict(raw)
        cfg["id"] = cfg.get("id", observable_id)
        cfg["name"] = cfg.get("name", cfg["id"])
        cfg["pythonClassName"] = cfg.get("pythonClassName", "")
        cfg["enabled"] = bool(cfg.get("enabled", True))
        cfg["executionModes"] = cfg.get("executionModes", ["TRAIN", "EVAL", "PREDICT"])
        cfg["finalizePhase"] = cfg.get("finalizePhase", "POST_RUN")
        cfg["retentionScope"] = cfg.get("retentionScope", "RUN")
        cfg["storageStrategy"] = cfg.get("storageStrategy", "SAMPLED")
        cfg["inputs"] = sorted(cfg.get("inputs", []), key=lambda item: int(str(item.get("targetHandle", "in-0")).split("-")[-1]))
        # Params are the source-diagram representation in the NNTree.  Merge
        # parsed values without changing the public compiled field names.
        params = cfg.pop("params", {})
        cfg.update(parse_params(params) if isinstance(params, dict) else {})
        observables[observable_id] = cfg
    return {"enabled": bool(section.get("enabled", False)) and bool(observables), "observables": observables}


def _build_nested_subflow_config(data: dict[str, Any]) -> dict[str, Any]:
    """Builds config for a nested subflow inside another subflow."""
    config: dict[str, Any] = {
        "entry_node": data["entryNode"],
        "internal_nodes": {},
    }
    python_class = data.get("pythonClassName", "")
    if python_class and python_class != "None" and "." in python_class:
        config["_target_"] = python_class
    else:
        config["_target_"] = "ops.Subflow"
    config["_recursive_"] = False
    config.update(parse_params(data.get("params", {})))
    for int_id, int_data in data.get("nodes", {}).items():
        int_type = int_data.get("type", "")
        if int_type in ("module", "join"):
            int_cfg = build_layer_config(int_data)
            int_cfg["inputs"] = int_data.get("inputs", [])
        elif int_type == "subflow":
            int_cfg = _build_nested_subflow_config(int_data)
        else:
            continue
        int_cfg["type"] = int_type
        int_cfg["children"] = int_data.get("children", [])
        config["internal_nodes"][int_id] = int_cfg
    return config


def build_hydra_configs(json_path: str | dict[str, Any], output_dir: str = "cfg", num_classes: int | None = None,
                        class_names: list[str] | None = None,
                        dataset: str = "dataset.mnist.MNISTDataset",
                        early_stop_patience: int = 3, early_stop_min_delta: float = 0.0,
                        max_epochs: int = 20,
                        training_config: dict[str, Any] | None = None):
    if isinstance(json_path, dict):
        diagram = json_path
    else:
        with open(json_path, "r") as f:
            diagram = json.load(f)

    training_config = training_config or {}
    optimizer_config = training_config.get(
        "optimizer", {"_target_": "torch.optim.Adam", "lr": 0.001}
    )
    trainer_config = training_config.get(
        "trainer", {"max_epochs": max_epochs, "accelerator": "auto"}
    )
    wandb_config = training_config.get(
        "wandb", {"project": "NeuralNetworks", "name": "Dynamic_Model"}
    )
    dataset_config = training_config.get(
        "dataset",
        {
            "_target_": dataset,
            "batch_size": 1024,
            "train_size": 0.8,
            "num_workers": 4,
        },
    )
    early_stopping_config = training_config.get(
        "early_stopping",
        {"patience": early_stop_patience, "min_delta": early_stop_min_delta},
    )

    for d in ["net", "optimizer", "trainer", "wandb", "dataset", "early_stopping", "interpretability"]:
        os.makedirs(os.path.join(output_dir, d), exist_ok=True)

    nntree = diagram.get("NNTree", diagram)

    loss_node = build_layer_config(nntree.get("lossNode", {})) if "lossNode" in nntree else None
    loss_task_type = (loss_node or {}).get("taskType", "")

    net_config_dict: dict[str, Any] = {
        "root": nntree.get("root", ""),
        "nodes": {},
        "lossNode": loss_node,
    }

    if loss_task_type == "classification":
        if num_classes is None:
            print("Warning: loss taskType is 'classification' but --num-classes not set. Defaulting to 10.")
            net_config_dict["num_classes"] = 10
        else:
            net_config_dict["num_classes"] = num_classes
        if class_names is not None:
            if len(class_names) != net_config_dict["num_classes"]:
                raise ValueError("class_names length must match num_classes")
            net_config_dict["class_names"] = class_names

    for node_id, node_info in nntree.get("nodes", {}).items():
        node_type = node_info["data"].get("type", "")
        node_config: dict[str, Any] = {
            "children": node_info.get("children", []),
            "type": node_type,
            "stereotype": node_info["data"].get("stereotype", ""),
        }

        if node_type == "sequential":
            node_config["layers"] = [
                build_layer_config(l) for l in node_info["data"].get("layers", [])
            ]
        elif node_type == "module":
            node_config["layer"] = build_layer_config(node_info["data"])
        elif node_type == "join":
            node_config["layer"] = build_layer_config(node_info["data"])
            node_config["inputs"] = node_info["data"].get("inputs", [])
        elif node_type == "subflow":
            data = node_info["data"]
            python_class = data.get("pythonClassName", "")
            if python_class and python_class != "None" and "." in python_class:
                node_config["_target_"] = python_class
            else:
                node_config["_target_"] = "ops.Subflow"
            node_config["_recursive_"] = False
            node_config["entry_node"] = data["entryNode"]
            node_config["internal_nodes"] = {}
            for int_id, int_data in data.get("nodes", {}).items():
                int_type = int_data.get("type", "")
                if int_type in ("module", "join"):
                    int_cfg = build_layer_config(int_data)
                    int_cfg["inputs"] = int_data.get("inputs", [])
                elif int_type == "subflow":
                    int_cfg = _build_nested_subflow_config(int_data)
                else:
                    continue
                int_cfg["type"] = int_type
                int_cfg["children"] = int_data.get("children", [])
                node_config["internal_nodes"][int_id] = int_cfg
            node_config.update(parse_params(data.get("params", {})))

        net_config_dict["nodes"][node_id] = node_config

    net_config = OmegaConf.create(net_config_dict)
    OmegaConf.save(
        config=net_config, f=os.path.join(output_dir, "net", "custom_sequence.yaml")
    )
    interpretability_config = build_interpretability_config(nntree)
    OmegaConf.save(
        config=OmegaConf.create(interpretability_config),
        f=os.path.join(output_dir, "interpretability", "observables.yaml"),
    )

    OmegaConf.save(config=OmegaConf.create(optimizer_config), f=os.path.join(output_dir, "optimizer", "adam.yaml"))
    OmegaConf.save(config=OmegaConf.create(trainer_config), f=os.path.join(output_dir, "trainer", "default.yaml"))
    OmegaConf.save(config=OmegaConf.create(wandb_config), f=os.path.join(output_dir, "wandb", "wandb.yaml"))
    OmegaConf.save(config=OmegaConf.create(dataset_config), f=os.path.join(output_dir, "dataset", "dataset.yaml"))
    OmegaConf.save(
        config=OmegaConf.create(early_stopping_config),
        f=os.path.join(output_dir, "early_stopping", "default.yaml"),
    )

    base_config = OmegaConf.create(
        {
            "defaults": [
                {"net": "custom_sequence"},
                {"interpretability": "observables"},
                {"optimizer": "adam"},
                {"trainer": "default"},
                {"wandb": "wandb"},
                {"dataset": "dataset"},
                {"early_stopping": "default"},
                "_self_",
            ],
            "seed": training_config.get("seed", 42),
        }
    )
    OmegaConf.save(config=base_config, f=os.path.join(output_dir, "base.yaml"))
    print(f"\nConfigurazione salvata con successo in '{output_dir}/'!")
    if loss_task_type == "classification":
        print(f"   - Task type: classification (num_classes={net_config_dict['num_classes']})")
    elif loss_task_type == "regression":
        print("   - Task type: regression")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert NNTree JSON to Hydra configs")
    parser.add_argument("json_path", nargs="?", default="../converted_minst.json",
                        help="Path to NNTree JSON file")
    parser.add_argument("output_dir", nargs="?", default="cfg",
                        help="Output directory for generated configs")
    parser.add_argument("--num-classes", type=int, default=None,
                        help="Number of classes (required for classification tasks)")
    parser.add_argument("--dataset", type=str, default="dataset.mnist.MNISTDataset",
                        help="Dataset class path (e.g. dataset.autoencoder_mnist.AutoencoderMNIST)")
    parser.add_argument("--early-stop-patience", type=int, default=3,
                        help="Early stopping patience (default: 3)")
    parser.add_argument("--early-stop-min-delta", type=float, default=0.0,
                        help="Early stopping min delta (default: 0.0)")
    parser.add_argument("--max-epochs", type=int, default=20,
                        help="Max training epochs (default: 20)")
    args = parser.parse_args()

    build_hydra_configs(args.json_path, output_dir=args.output_dir,
                        num_classes=args.num_classes, dataset=args.dataset,
                        early_stop_patience=args.early_stop_patience,
                        early_stop_min_delta=args.early_stop_min_delta,
                        max_epochs=args.max_epochs)
