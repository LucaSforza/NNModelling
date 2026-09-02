"""Classify one MNIST-style image with an installed NNModelling model."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch

from nnm_resnet_mnist import Model


def classify(model: Model, image: Path) -> dict[str, object]:
    """Return the top three classes for one image path."""

    scores = model.predict(image)
    if not isinstance(scores, torch.Tensor):
        raise TypeError("Model.predict must return a torch.Tensor")
    if scores.ndim == 2 and scores.shape[0] == 1:
        scores = scores[0]
    if scores.ndim != 1 or scores.numel() != 10:
        raise ValueError(f"Model.predict returned shape {tuple(scores.shape)}; expected [10]")

    probabilities = torch.softmax(scores, dim=0)
    values, indices = torch.topk(probabilities, k=3)
    top3 = [
        {"digit": int(digit), "probability": float(probability)}
        for probability, digit in zip(values.tolist(), indices.tolist())
    ]
    return {
        "digit": top3[0]["digit"],
        "confidence": top3[0]["probability"],
        "top3": top3,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="PNG or JPEG containing one grayscale digit")
    args = parser.parse_args()
    if not args.image.is_file():
        parser.error(f"image not found: {args.image}")

    result = classify(Model(), args.image)
    print(f"Predicted digit: {result['digit']}")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
