"""Generate an MNIST reconstruction gallery from a downloaded model wheel."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib
import json
import struct
import sys
from pathlib import Path
from typing import Any, Protocol

from PIL import Image


EXAMPLE_DIR = Path(__file__).resolve().parent
REPO_DIR = EXAMPLE_DIR.parents[1]
DEFAULT_OUTPUT_DIR = EXAMPLE_DIR / "generated"
MNIST_MEAN = 0.1307
MNIST_STD = 0.3081
MNIST_IMAGE_MAGIC = 2051
MNIST_LABEL_MAGIC = 2049


class InferenceModel(Protocol):
    """Public model interface supplied by an exported wheel."""

    def predict(self, value: object) -> Any:
        """Adapt one input value and return the declared prediction."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_model(wheel_path: Path, package_name: str) -> InferenceModel:
    """Import the downloaded wheel and use only its public ``load_model`` API."""

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


def _idx_bytes(path: Path) -> bytes:
    """Read an IDX file, accepting either the prepared file or its gzip source."""

    if path.is_file():
        return path.read_bytes()
    compressed = path.with_name(path.name + ".gz")
    if compressed.is_file():
        with gzip.open(compressed, "rb") as stream:
            return stream.read()
    raise FileNotFoundError(f"MNIST file not found: {path}")


def _mnist_images(raw_dir: Path, count: int) -> list[Image.Image]:
    """Read a deterministic prefix of the prepared MNIST test image IDX file."""

    payload = _idx_bytes(raw_dir / "t10k-images-idx3-ubyte")
    magic, image_count, rows, columns = struct.unpack_from(">IIII", payload)
    if magic != MNIST_IMAGE_MAGIC or (rows, columns) != (28, 28):
        raise ValueError("unsupported MNIST image IDX file")
    if count < 1 or count > image_count:
        raise ValueError(f"sample count must be between 1 and {image_count}")
    offset = 16
    size = rows * columns
    return [
        Image.frombytes("L", (columns, rows), payload[offset + index * size : offset + (index + 1) * size])
        for index in range(count)
    ]


def _mnist_labels(raw_dir: Path) -> list[int]:
    """Read the deterministic MNIST test labels used to choose interpolation endpoints."""

    payload = _idx_bytes(raw_dir / "t10k-labels-idx1-ubyte")
    magic, count = struct.unpack_from(">II", payload)
    if magic != MNIST_LABEL_MAGIC or len(payload) < 8 + count:
        raise ValueError("unsupported MNIST label IDX file")
    return list(payload[8 : 8 + count])


def _mnist_images_at(raw_dir: Path, indices: list[int]) -> list[Image.Image]:
    """Read selected MNIST test images without loading labels into the model API."""

    if not indices or min(indices) < 0:
        raise ValueError("image indices must be non-negative")
    payload = _idx_bytes(raw_dir / "t10k-images-idx3-ubyte")
    magic, image_count, rows, columns = struct.unpack_from(">IIII", payload)
    if magic != MNIST_IMAGE_MAGIC or (rows, columns) != (28, 28) or max(indices) >= image_count:
        raise ValueError("unsupported MNIST image IDX file")
    offset = 16
    size = rows * columns
    return [
        Image.frombytes("L", (columns, rows), payload[offset + index * size : offset + (index + 1) * size])
        for index in indices
    ]


def _prediction_image(prediction: Any, size: tuple[int, int] = (28, 28)) -> Image.Image:
    """Convert the public prediction tensor into a displayable grayscale image."""

    values = _flatten_public_values(prediction)
    expected = size[0] * size[1]
    if len(values) != expected:
        raise ValueError(f"wheel prediction has {len(values)} values; expected {expected}")
    pixels = bytes(
        max(0, min(255, round((float(value) * MNIST_STD + MNIST_MEAN) * 255))) for value in values
    )
    return Image.frombytes("L", size, pixels)


def _flatten_public_values(value: Any) -> list[Any]:
    """Normalize tensor-like or JSON-compatible public outputs to scalar values."""

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
        raise TypeError("wheel output must contain numeric values")
    return [value]


def _batch_rows(value: Any, count: int) -> list[list[Any]]:
    """Read a batch from a public adapter without depending on its tensor library."""

    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "reshape") and hasattr(value, "tolist"):
        value = value.reshape(count, -1).tolist()
    elif hasattr(value, "tolist"):
        value = value.tolist()
    if not isinstance(value, (list, tuple)) or len(value) != count:
        raise ValueError(f"wheel adapter returned an invalid batch; expected {count} rows")
    rows = [_flatten_public_values(row) for row in value]
    return rows


def _save_image_grid(images: list[Image.Image], path: Path) -> None:
    """Save a square-ish grid of generated images without inspecting model internals."""

    columns = min(4, len(images))
    rows = (len(images) + columns - 1) // columns
    width, height = images[0].size
    sheet = Image.new("L", (columns * width, rows * height), color=255)
    for index, image in enumerate(images):
        sheet.paste(image, ((index % columns) * width, (index // columns) * height))
    sheet.save(path)


def _sample_from_prior(model: InferenceModel, count: int) -> list[Image.Image]:
    """Generate images through the VAE's declared ``sample`` and ``forward`` adapters.

    The packed latent input contains zero means and log-variances.  The wheel's
    sampler therefore draws from the standard normal prior, while the decoder
    adapter turns those sampled latents into images.  No private graph node or
    framework object is needed by this example.
    """

    if count < 1:
        raise ValueError("sample count must be positive")
    packed_prior = [[0.0] * 64 for _ in range(count)]
    sampled_latents = model.adapter("sample").run(packed_prior)
    generated_batch = model.adapter("forward").run(sampled_latents)
    rows = _batch_rows(generated_batch, count)
    return [_prediction_image(row) for row in rows]


def _encode_means(model: InferenceModel, images: list[Image.Image]) -> list[list[float]]:
    """Encode normalized images and retain only the first half, the declared mean."""

    inputs = [
        [(pixel / 255.0 - MNIST_MEAN) / MNIST_STD for pixel in image.getdata()]
        for image in images
    ]
    packed = _batch_rows(model.adapter("encode").run(inputs), len(images))
    latent_dim = 32
    if any(len(row) != latent_dim * 2 for row in packed):
        raise ValueError("encoder adapter must return 64 packed latent values")
    return [row[:latent_dim] for row in packed]


def _interpolate_latent(
    model: InferenceModel,
    start: Image.Image,
    end: Image.Image,
    steps: int,
) -> list[Image.Image]:
    """Decode a linear interpolation between two encoded posterior means."""

    if steps < 2:
        raise ValueError("interpolation requires at least two steps")
    start_latent, end_latent = _encode_means(model, [start, end])
    latents = [
        [start_value * (1.0 - t) + end_value * t for start_value, end_value in zip(start_latent, end_latent)]
        for t in [index / (steps - 1) for index in range(steps)]
    ]
    generated = _batch_rows(model.adapter("forward").run(latents), steps)
    return [_prediction_image(row) for row in generated]


def _save_comparison_grid(originals: list[Image.Image], reconstructions: list[Image.Image], path: Path) -> None:
    """Save originals beside their reconstructions in a compact gallery."""

    columns = min(4, len(originals))
    rows = (len(originals) + columns - 1) // columns
    tile_width, tile_height = originals[0].size[0] * 2, originals[0].size[1]
    sheet = Image.new("L", (columns * tile_width, rows * tile_height), color=255)
    for index, (original, reconstruction) in enumerate(zip(originals, reconstructions)):
        x = (index % columns) * tile_width
        y = (index // columns) * tile_height
        sheet.paste(original, (x, y))
        sheet.paste(reconstruction, (x + original.size[0], y))
    sheet.save(path)


def generate(
    wheel_path: Path,
    package_name: str,
    output_dir: Path,
    seed: int,
    data_dir: Path = REPO_DIR / "converted" / "data" / "MNIST" / "raw",
    sample_count: int = 16,
    from_digit: int = 1,
    to_digit: int = 7,
    interpolation_steps: int = 9,
) -> dict[str, Any]:
    """Create a reconstruction gallery using only the wheel's public API.

    ``seed`` is retained for CLI compatibility and provenance; inference itself
    is deterministic because the exported model is evaluated in inference mode.
    """

    model = _load_model(wheel_path, package_name)
    originals = _mnist_images(data_dir, sample_count)
    reconstructions = [_prediction_image(model.predict(image)) for image in originals]
    generated = _sample_from_prior(model, sample_count)
    labels = _mnist_labels(data_dir)
    try:
        endpoint_indices = [labels.index(from_digit), labels.index(to_digit)]
    except ValueError as exc:
        raise ValueError("interpolation endpoint digit is not present in MNIST test labels") from exc
    endpoints = _mnist_images_at(data_dir, endpoint_indices)
    interpolated = _interpolate_latent(model, endpoints[0], endpoints[1], interpolation_steps)

    output_dir.mkdir(parents=True, exist_ok=True)
    reconstruction_path = output_dir / "reconstructions.png"
    _save_comparison_grid(originals, reconstructions, reconstruction_path)

    result = {
        "wheel": wheel_path.name,
        "wheel_sha256": _sha256(wheel_path),
        "package": package_name,
        "seed": seed,
        "sample_count": sample_count,
        "outputs": {
            "reconstructions": reconstruction_path.name,
        },
    }
    generated_path = output_dir / "prior-samples.png"
    _save_image_grid(generated, generated_path)
    result["outputs"]["prior_samples"] = generated_path.name
    interpolation_path = output_dir / f"latent-interpolation-{from_digit}-to-{to_digit}.png"
    _save_image_grid(interpolated, interpolation_path)
    result["outputs"]["latent_interpolation"] = interpolation_path.name
    result["latent_interpolation"] = {
        "from_digit": from_digit,
        "to_digit": to_digit,
        "steps": interpolation_steps,
        "latent_dim": 32,
    }
    (output_dir / "generation-summary.json").write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheel", type=Path, required=True)
    parser.add_argument("--package-name", required=True)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--data-dir", type=Path, default=REPO_DIR / "converted" / "data" / "MNIST" / "raw")
    parser.add_argument("--sample-count", type=int, default=16)
    parser.add_argument("--from-digit", type=int, default=1)
    parser.add_argument("--to-digit", type=int, default=7)
    parser.add_argument("--interpolation-steps", type=int, default=9)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    print(
        json.dumps(
            generate(
                args.wheel,
                args.package_name,
                args.output_dir,
                args.seed,
                args.data_dir,
                args.sample_count,
                args.from_digit,
                args.to_digit,
                args.interpolation_steps,
            ),
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
