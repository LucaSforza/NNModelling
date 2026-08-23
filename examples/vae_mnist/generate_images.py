"""Generate MNIST reconstructions and samples from a downloaded NNModelling package."""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
import zipfile
from pathlib import Path
from typing import Any

import torch
from safetensors.torch import load_file
from torchvision import datasets, transforms
from torchvision.utils import save_image

from package_runtime import compile_package_graph


EXAMPLE_DIR = Path(__file__).resolve().parent
REPO_DIR = EXAMPLE_DIR.parents[1]
DEFAULT_PACKAGE = EXAMPLE_DIR / "vae_mnist_trained-package.zip"
DEFAULT_OUTPUT_DIR = EXAMPLE_DIR / "generated"
MNIST_MEAN = 0.1307
MNIST_STD = 0.3081


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_extract(archive: zipfile.ZipFile, destination: Path) -> None:
    """Extract the trusted package without allowing paths outside the temp dir."""

    root = destination.resolve()
    for member in archive.infolist():
        target = (root / member.filename).resolve()
        if root not in target.parents and target != root:
            raise ValueError(f"unsafe archive member: {member.filename}")
    archive.extractall(root)


def _load_model(package_path: Path) -> tuple[torch.nn.Module, dict[str, Any], dict[str, Any]]:
    """Compile the graph in the archive and restore its safetensors weights."""

    with zipfile.ZipFile(package_path) as archive:
        broken_member = archive.testzip()
        if broken_member is not None:
            raise ValueError(f"corrupt archive member: {broken_member}")
        required = {"package.json", "weights.safetensors", "training-summary.json"}
        missing = required.difference(archive.namelist())
        if missing:
            raise ValueError(f"trained package is missing: {', '.join(sorted(missing))}")
        package = json.loads(archive.read("package.json"))
        training_summary = json.loads(archive.read("training-summary.json"))
        with tempfile.TemporaryDirectory(prefix="nnm-trained-package-") as temp_dir:
            extracted = Path(temp_dir)
            _safe_extract(archive, extracted)
            model = compile_package_graph(package)
            state = load_file(str(extracted / "weights.safetensors"), device="cpu")
            model.load_state_dict(state, strict=True)
    model.eval()
    return model, package, training_summary


def _display(images: torch.Tensor) -> torch.Tensor:
    """Undo the MNIST normalization used during training for PNG output."""

    return (images * MNIST_STD + MNIST_MEAN).clamp(0, 1)


def generate(package_path: Path, output_dir: Path, seed: int) -> dict[str, Any]:
    """Generate a reconstruction grid and a random-latent sample grid."""

    torch.manual_seed(seed)
    model, package, training_summary = _load_model(package_path)
    modules = getattr(model, "modules_by_id", None)
    if modules is None:
        raise ValueError("package root does not expose graph modules")
    required_modules = {"flatten", "encoder", "sample-z", "decoder"}
    missing = required_modules.difference(modules.keys())
    if missing:
        raise ValueError(f"VAE graph is missing: {', '.join(sorted(missing))}")

    transform = transforms.Compose(
        [transforms.ToTensor(), transforms.Normalize((MNIST_MEAN,), (MNIST_STD,))]
    )
    dataset = datasets.MNIST(
        root=str(REPO_DIR / "converted" / "data"),
        train=False,
        download=True,
        transform=transform,
    )
    samples = torch.stack([dataset[index][0] for index in range(16)])

    with torch.inference_mode():
        latent_parameters = modules["encoder"](modules["flatten"](samples))
        reconstructions = modules["decoder"](modules["sample-z"](latent_parameters))
        first_linear = next(
            layer for layer in modules["decoder"].modules() if isinstance(layer, torch.nn.Linear)
        )
        latent = torch.randn(16, first_linear.in_features)
        generated = modules["decoder"](latent)

    output_dir.mkdir(parents=True, exist_ok=True)
    reconstruction_path = output_dir / "reconstructions.png"
    generated_path = output_dir / "generated.png"
    save_image(_display(reconstructions.reshape(-1, 1, 28, 28)), reconstruction_path, nrow=4)
    save_image(_display(generated.reshape(-1, 1, 28, 28)), generated_path, nrow=4)

    result = {
        "package": package_path.name,
        "package_sha256": _sha256(package_path),
        "package_format": package.get("format"),
        "training": training_summary,
        "seed": seed,
        "latent_dim": first_linear.in_features,
        "outputs": {
            "reconstructions": reconstruction_path.name,
            "generated": generated_path.name,
        },
    }
    (output_dir / "generation-summary.json").write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, default=DEFAULT_PACKAGE)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    print(json.dumps(generate(args.package, args.output_dir, args.seed), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
