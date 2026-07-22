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
import importlib
import os
import sys

import hydra
import lightning as lit
import lightning.pytorch.callbacks as cb
import torch
from lightning.pytorch.loggers import WandbLogger
from omegaconf import DictConfig, OmegaConf

import ops
import wandb
from hydra.utils import instantiate
from net.base import Net


def get_num_params(module):
    """
    Returns the number of parameters in a Lightning module.

    Args:
        module (lightning.pytorch.LightningModule): The Lightning module to get the number of parameters for.

    Returns:
        int: The number of parameters in the module.
    """
    total_params = sum(p.numel() for p in module.parameters())
    return total_params


@hydra.main(
    config_path=None,  # Will be set dynamically
    config_name=None,  # Will be set dynamically
    version_base="1.3",
)
def main(cfg: DictConfig):
    print("Configuration:")
    print(OmegaConf.to_yaml(cfg))

    lit.seed_everything(cfg.seed)
    wandb_logger = WandbLogger(**cfg.wandb)
    try:
        print(f"W&B URL: {wandb_logger.experiment.url}", flush=True)
    except (AttributeError, RuntimeError):
        # Disabled/offline W&B modes may not expose a public run URL.
        pass

    model = Net(cfg)
    # Publication is optional; the manager itself remains independent of the
    # Lightning logger and always has a local publisher.
    model.interpretability.publisher.experiment = getattr(wandb_logger, "experiment", None)
    model.interpretability.publisher.wandb = wandb
    print(f"Observable results: {model.interpretability.publisher.run_dir}", flush=True)

    dataset = instantiate(cfg.dataset)
    train_loader, val_loader, test_loader = dataset.division()

    task_type = cfg.net.lossNode.get("taskType", "classification")
    es_mode = "min" if task_type == "regression" else "max"
    es_cfg = cfg.early_stopping
    trainer = lit.Trainer(
        logger=wandb_logger,
        callbacks=[
            cb.EarlyStopping(
                monitor="val_metric", patience=es_cfg.patience, verbose=True,
                mode=es_mode, min_delta=es_cfg.min_delta,
            )
        ],
        **cfg.trainer,
    )

    print("Training...")
    trainer.fit(model, train_loader, val_loader)

    print("Testing...")
    trainer.test(model, test_loader)

    hyperparams_dict = OmegaConf.to_container(cfg, resolve=True)
    hyperparams_dict["info"] = {
        "num_params": get_num_params(model),
    }

    model.interpretability.finalize("POST_RUN")
    model.cleanup_interpretability()
    torch.save(model, "weights.pt")
    from safetensors.torch import save_file

    save_file(model.state_dict(), "weights.safetensors")
    wandb_logger.log_hyperparams(hyperparams_dict)


if __name__ == "__main__":
    os.environ["HYDRA_FULL_ERROR"] = "1"

    # Parse command line arguments for config path
    config_path = None
    config_name = None

    # Extract --config-path and --config-name from args
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--config-path" and i + 1 < len(args):
            config_path = args[i + 1]
            i += 2
        elif args[i] == "--config-name" and i + 1 < len(args):
            config_name = args[i + 1]
            i += 2
        else:
            i += 1

    # Override the hydra.main decorator with dynamic config path
    if config_path is not None and config_name is not None:
        # Resolve config_path relative to script directory
        script_dir = os.path.dirname(os.path.abspath(__file__))
        full_config_path = os.path.join(script_dir, config_path)
        main = hydra.main(
            config_path=full_config_path,
            config_name=config_name,
            version_base="1.3",
        )(main)
        main()
    else:
        # Default: use cfg directory relative to script (one level up)
        script_dir = os.path.dirname(os.path.abspath(__file__))
        # Go up one level from src/ to converted/
        script_parent = os.path.dirname(script_dir)
        full_config_path = os.path.join(script_parent, "cfg")
        main = hydra.main(
            config_path=full_config_path,
            config_name="base",
            version_base="1.3",
        )(main)
        main()
