"""Predict the digit represented by one MNIST-style image."""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import math
import sys
from pathlib import Path
from typing import Any, Protocol


class InferenceModel(Protocol):
    """Public inference interface supplied by an exported model wheel."""

    def predict(self, value: object) -> Any:
        """Run the model's declared prediction program."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _flatten_public_values(value: Any) -> list[Any]:
    """Normalize a tensor-like or JSON-compatible output to scalar values."""

    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "reshape") and hasattr(value, "tolist"):
        value = value.reshape(-1).tolist()
    elif hasattr(value, "tolist"):
        value = value.tolist()

    if isinstance(value, (list, tuple)):
        flattened: list[Any] = []
        for item in value:
            flattened.extend(_flatten_public_values(item))
        return flattened
    if isinstance(value, (str, bytes)) or value is None:
        raise TypeError("model output must contain numeric values")
    return [value]


def _softmax(logits: list[float]) -> list[float]:
    """Convert logits to probabilities without overflowing on large values."""

    maximum = max(logits)
    exponentials = [math.exp(value - maximum) for value in logits]
    total = sum(exponentials)
    return [value / total for value in exponentials]


def _load_model(wheel_path: Path, package_name: str) -> InferenceModel:
    """Import a downloaded wheel through its public ``load_model`` API."""

    if not wheel_path.is_file() or wheel_path.suffix != ".whl":
        raise ValueError(f"wheel not found: {wheel_path}")
    sys.path.insert(0, str(wheel_path))
    try:
        package = importlib.import_module(package_name)
        loaded = package.load_model()
    finally:
        sys.path.remove(str(wheel_path))
    if not callable(getattr(loaded, "predict", None)):
        raise ValueError("wheel model does not expose the public predict API")
    return loaded


def predict_digit(model: InferenceModel, image_path: Path) -> dict[str, Any]:
    """Predict one digit, delegating image conversion to the wheel adapter."""

    if not image_path.is_file():
        raise FileNotFoundError(f"image not found: {image_path}")
    scores = [float(value) for value in _flatten_public_values(model.predict(image_path))]
    if len(scores) != 10:
        raise ValueError(f"model returned {len(scores)} scores; expected 10")
    probabilities = _softmax(scores)
    ranked = sorted(range(10), key=probabilities.__getitem__, reverse=True)
    return {
        "digit": ranked[0],
        "confidence": probabilities[ranked[0]],
        "top3": [{"digit": digit, "probability": probabilities[digit]} for digit in ranked[:3]],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheel", type=Path, required=True, help="downloaded trained model wheel")
    parser.add_argument("--package-name", required=True, help="Python package name embedded in the wheel")
    parser.add_argument("--image", type=Path, required=True, help="PNG/JPEG image containing one digit")
    args = parser.parse_args()

    result = predict_digit(_load_model(args.wheel, args.package_name), args.image)
    print(f"Predicted digit: {result['digit']}")
    print(json.dumps({"wheel": args.wheel.name, "wheel_sha256": _sha256(args.wheel), **result}, indent=2))


if __name__ == "__main__":
    main()
