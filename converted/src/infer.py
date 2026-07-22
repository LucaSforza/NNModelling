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
import os
import sys
import json
import argparse

import torch
import torch.nn.functional as F
import lightning as lit
from hydra import compose, initialize_config_dir
from hydra.utils import instantiate
from torchvision.utils import make_grid, save_image

from net.base import Net


def is_image_tensor(t: torch.Tensor) -> bool:
    """Heuristic: tensor with spatial dims and 1/3/4 channels is an image."""
    if t.dim() >= 3:
        *_, h, w = t.shape[-3:]
        return h < 1000 and w < 1000 and t.shape[-3] in (1, 3, 4)
    return False


def to_image_tensor(t: torch.Tensor) -> torch.Tensor:
    """Normalize to [0,1] and ensure 3D [C,H,W] or 4D [B,C,H,W]."""
    t = t.float()
    if t.numel() == 0:
        return t
    lo, hi = t.min(), t.max()
    if lo < 0 or hi > 1:
        t = (t - lo) / (hi - lo + 1e-8)
    # Remove batch dim if present
    while t.dim() > 3:
        t = t.squeeze(0)
    # Add channel dim if grayscale without channel
    if t.dim() == 2:
        t = t.unsqueeze(0)
    return t


def iter_predict_batches(model: torch.nn.Module, loader, device: str, observe: bool = True):
    """Run direct prediction batches with the complete Observable lifecycle."""
    manager = getattr(model, "interpretability", None)
    previous_enabled = manager.global_enabled if manager is not None else False
    if manager is not None and not observe:
        manager.global_enabled = False
    try:
        with torch.no_grad():
            for batch_index, batch in enumerate(loader):
                x, y = batch
                x = x.to(device)
                if manager is not None and observe:
                    manager.set_context(
                        "PREDICT", getattr(model, "current_epoch", None),
                        getattr(model, "global_step", None), batch_index,
                    )
                y_hat = model(x)
                if manager is not None and observe:
                    manager.finalize("POST_BATCH")
                yield x, y, y_hat
    finally:
        if manager is not None and observe:
            manager.finalize("POST_EPOCH")
        if manager is not None and not observe:
            manager.global_enabled = previous_enabled


def save_samples(
    model: torch.nn.Module,
    test_loader,
    image_dir: str,
    device: str,
    max_samples: int = 64,
    observe: bool = True,
):
    """Save image visualizations: per-sample strips + montage grid."""
    os.makedirs(image_dir, exist_ok=True)
    strips: list[torch.Tensor] = []
    sample_count = 0
    output_is_image = None

    batches = iter_predict_batches(model, test_loader, device, observe=observe)
    try:
        for x, y, y_hat in batches:
            if output_is_image is None:
                output_is_image = is_image_tensor(y_hat)

            for i in range(len(x)):
                if sample_count >= max_samples:
                    break

                inp = to_image_tensor(x[i].cpu())  # [C, H, W]

                if output_is_image:
                    target = to_image_tensor(y[i].cpu() if torch.is_tensor(y) else y)
                    pred = to_image_tensor(y_hat[i].cpu())
                    # Ensure same spatial size
                    if target.shape[-2:] != inp.shape[-2:]:
                        target = F.interpolate(
                            target.unsqueeze(0), size=inp.shape[-2:], mode="nearest"
                        ).squeeze(0)
                    if pred.shape[-2:] != inp.shape[-2:]:
                        pred = F.interpolate(
                            pred.unsqueeze(0), size=inp.shape[-2:], mode="nearest"
                        ).squeeze(0)
                    # Strip: [input | target | prediction]
                    strip = torch.cat([inp, target, pred], dim=-1)
                else:
                    strip = inp  # just the input image

                strips.append(strip)
                sample_count += 1

                if sample_count >= max_samples:
                    break
            if sample_count >= max_samples:
                break
    finally:
        batches.close()

    if not strips:
        print("  No image data to save.")
        return

    # Montage grid
    batch = torch.stack(strips)  # [N, C, H, W]
    grid = make_grid(batch, nrow=8, padding=2, pad_value=1)
    save_image(grid, os.path.join(image_dir, "montage.png"))
    print(f"  Saved {len(strips)} samples to {image_dir}/ (view montage.png)")

    # Individual samples for the first 10
    for i, strip in enumerate(strips[:10]):
        save_image(strip, os.path.join(image_dir, f"sample_{i:03d}.png"))
    if len(strips) > 10:
        print(f"  Also saved individual PNGs for samples 000–{min(9, len(strips)-1):03d}")


def main():
    parser = argparse.ArgumentParser(description="Run inference with trained model")
    parser.add_argument("--config-path", default="cfg", help="Config directory (default: cfg)")
    parser.add_argument("--config-name", default="base", help="Config name (default: base)")
    parser.add_argument("--weights", default="weights.pt", help="Model weights (default: weights.pt)")
    parser.add_argument("--output", default=None, help="Save predictions to JSON file")
    parser.add_argument("--image-dir", default=None, help="Save image visualizations to directory")
    parser.add_argument("--device", default="cpu", help="Device (default: cpu)")
    parser.add_argument(
        "--interpretability-root",
        default=None,
        help="Stable parent directory for this run's Observable results",
    )
    parser.add_argument(
        "--interpretability-run-id",
        default=None,
        help="Optional externally assigned ID for this inference run",
    )
    args = parser.parse_args()

    # Resolve paths relative to converted/ (parent of src/)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)

    config_path = os.path.join(project_root, args.config_path)
    weights_path = os.path.join(project_root, args.weights)

    if not os.path.exists(config_path):
        print(f"Config directory not found: {config_path}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(weights_path):
        print(f"Weights file not found: {weights_path}", file=sys.stderr)
        sys.exit(1)

    # Load composed Hydra config
    with initialize_config_dir(config_dir=config_path, version_base=None):
        cfg = compose(config_name=args.config_name)

    # Load model and set to eval
    print(f"Loading model from {weights_path} ...")
    model = torch.load(weights_path, map_location=args.device, weights_only=False)
    model.eval()
    if hasattr(model, "interpretability"):
        # Hooks are intentionally removed before pickle serialization; bind
        # them again only for this prediction process.
        model.interpretability.configure_run(args.interpretability_root, args.interpretability_run_id)
        print(f"Observable results: {model.interpretability.publisher.run_dir}", flush=True)
        model.interpretability.attach()
        if model.interpretability.observables:
            model._bind_subflow_observers()
        model.interpretability.begin_scope("predict", "PREDICT")

    # Load dataset
    print("Loading dataset ...")
    dataset = instantiate(cfg.dataset)
    _, _, test_loader = dataset.division()

    # Run test loop via Lightning Trainer for metrics
    print("Running inference ...")
    try:
        trainer = lit.Trainer(logger=False, enable_progress_bar=True)
        results = trainer.test(model, test_loader)
        print("\nResults:")
        for key, value in results[0].items():
            print(f"  {key}: {value:.6f}")
    except Exception as e:
        print(f"  Metrics unavailable (loss function mismatch): {e}")

    # Save predictions if requested
    prediction_scope = bool(args.output or args.image_dir)
    if prediction_scope and hasattr(model, "interpretability"):
        # Trainer.test owns a separate EVAL scope.  Prediction must reopen a
        # fresh scope so POST_RUN idempotency does not suppress captures.
        model.interpretability.begin_scope("predict", "PREDICT")

    if args.output:
        print("\nCollecting predictions ...")
        if hasattr(model, "interpretability"):
            model.interpretability.set_context("PREDICT")
        predictions = []
        for x, y, y_hat in iter_predict_batches(model, test_loader, args.device):
            # Argmax for classification, raw output for regression
            if y_hat.dim() > 1 and y_hat.size(1) > 1:
                preds = y_hat.argmax(dim=1)
            else:
                preds = y_hat
            for i in range(len(x)):
                predictions.append({
                    "input": x[i].cpu().tolist(),
                    "target": y[i].cpu().tolist() if torch.is_tensor(y) else y[i],
                    "prediction": preds[i].cpu().tolist() if torch.is_tensor(preds) else preds[i],
                })

        output_path = os.path.join(project_root, args.output) if not os.path.isabs(args.output) else args.output
        with open(output_path, "w") as f:
            json.dump(predictions, f, indent=2)
        print(f"Saved {len(predictions)} predictions to {output_path}")

    # Save image visualizations if requested
    if args.image_dir:
        if hasattr(model, "interpretability"):
            model.interpretability.set_context("PREDICT")
        image_path = os.path.join(project_root, args.image_dir) if not os.path.isabs(args.image_dir) else args.image_dir
        save_samples(model, test_loader, image_path, args.device, observe=not bool(args.output))

    if hasattr(model, "interpretability"):
        if prediction_scope:
            model.interpretability.end_scope()
        model.cleanup_interpretability()


if __name__ == "__main__":
    main()
