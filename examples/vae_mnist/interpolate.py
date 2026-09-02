"""Run a small 1-to-7 latent interpolation with an installed VAE wheel."""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
from PIL import Image

from nnm_vae_export import Model


EXAMPLE_DIR = Path(__file__).resolve().parent
FIXTURE_DIR = EXAMPLE_DIR / "fixtures"
OUTPUT_PATH = EXAMPLE_DIR / "generated" / "interpolation-1-to-7.png"
MNIST_MEAN = 0.1307
MNIST_STD = 0.3081


def _encoder_tensor(model: Model, path: Path) -> torch.Tensor:
    """Use the wheel's image adapter and flatten its normalized batch."""

    tensor = model.input_adapter.to_tensor(path)
    if tensor.shape != (1, 1, 28, 28):
        raise ValueError(f"image adapter returned {tuple(tensor.shape)}; expected (1, 1, 28, 28)")
    return tensor.flatten(1)


def _prediction_image(tensor: torch.Tensor) -> Image.Image:
    """Convert one model output row back to a grayscale MNIST image."""

    if tensor.shape != (784,):
        raise ValueError(f"expected one decoded image with shape (784,), got {tuple(tensor.shape)}")
    pixels = ((tensor.detach().cpu() * MNIST_STD + MNIST_MEAN).clamp(0, 1) * 255).round().to(torch.uint8)
    return Image.frombytes("L", (28, 28), bytes(pixels.tolist()))


def _grid(images: list[Image.Image]) -> Image.Image:
    """Arrange interpolation frames in a single readable strip."""

    if not images:
        raise ValueError("at least one image is required")
    width, height = images[0].size
    sheet = Image.new("L", (width * len(images), height), color=255)
    for index, image in enumerate(images):
        sheet.paste(image, (index * width, 0))
    return sheet


def interpolate(steps: int = 9, output_path: Path = OUTPUT_PATH) -> Path:
    """Encode local 1/7 fixtures and decode their linearly interpolated means."""

    if steps < 2:
        raise ValueError("steps must be at least 2")
    one_path = FIXTURE_DIR / "one.png"
    seven_path = FIXTURE_DIR / "seven.png"
    model = Model()

    one = _encoder_tensor(model, one_path)
    seven = _encoder_tensor(model, seven_path)
    for fixture in (one_path, seven_path):
        prediction = model.predict(fixture)
        if prediction.shape != (1, 784):
            raise ValueError(f"prediction adapter returned {tuple(prediction.shape)}; expected (1, 784)")

    encoded = model.adapter("encode").run(torch.cat([one, seven], dim=0))
    if encoded.shape != (2, 64):
        raise ValueError(f"encode adapter returned {tuple(encoded.shape)}; expected (2, 64)")
    start, end = encoded[0, :32], encoded[1, :32]
    fractions = torch.linspace(0, 1, steps=steps).reshape(-1, 1)
    latents = start * (1 - fractions) + end * fractions
    decoded = model.adapter("forward").run(latents)
    if decoded.shape != (steps, 784):
        raise ValueError(f"forward adapter returned {tuple(decoded.shape)}; expected ({steps}, 784)")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    _grid([_prediction_image(row) for row in decoded]).save(output_path)
    return output_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--steps", type=int, default=9)
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    args = parser.parse_args()
    print(interpolate(args.steps, args.output))


if __name__ == "__main__":
    main()
