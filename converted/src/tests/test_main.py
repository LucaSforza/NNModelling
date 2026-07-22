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
"""Training smoke tests: run main.py for 1 epoch on autoencoder + MNIST classifier.

IMPORTANT: main.py saves weights.pt to the subprocess CWD (PROJECT_ROOT),
not to hydra.run.dir. This is because Hydra creates the output directory
structure but the app process runs from the original CWD.
"""

import subprocess
from pathlib import Path
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent  # converted/
FIXTURES_DIR = PROJECT_ROOT.parent / "examples" / "nntrees"


@pytest.fixture(autouse=True)
def clean_training_artifacts():
    """Keep subprocess checkpoints out of the repository after every test."""
    yield
    for filename in ("weights.pt", "weights.safetensors"):
        artifact = PROJECT_ROOT / filename
        if artifact.exists():
            artifact.unlink()


def test_autoencoder_training(tmp_path):
    """main.py trains autoencoder for 1 epoch without errors."""
    json_path = FIXTURES_DIR / "auto_encoder.json"
    assert json_path.exists(), f"Fixture not found: {json_path}"

    # Step 1: Convert with autoencoder dataset
    cfg_dir = tmp_path / "cfg"
    result = subprocess.run([
        "uv", "run", "python", "src/convert.py",
        str(json_path), str(cfg_dir),
        "--dataset", "dataset.autoencoder_mnist.AutoencoderMNIST",
    ], capture_output=True, text=True, timeout=120, cwd=str(PROJECT_ROOT))
    cmd = "uv run python src/convert.py"
    assert result.returncode == 0, (
        f"convert.py failed:\n"
        f"  CMD: {cmd} {json_path} {cfg_dir} --dataset dataset.autoencoder_mnist.AutoencoderMNIST\n"
        f"  CWD: {PROJECT_ROOT}\n"
        f"  STDERR:\n{result.stderr}\n"
        f"  STDOUT:\n{result.stdout}"
    )

    # Step 2: Train for 1 epoch
    # NOTE: weights.pt is saved to PROJECT_ROOT (subprocess CWD), not to the
    # Hydra output directory (hydra.run.dir). The Hydra run.dir only receives
    # .hydra/ config backup and main.log.
    result = subprocess.run([
        "uv", "run", "python", "src/main.py",
        "--config-path", str(cfg_dir),
        "--config-name", "base",
        "trainer.max_epochs=1",
        "trainer.accelerator=cpu",
        "+trainer.enable_progress_bar=false",
        "+wandb.mode=disabled",
        "dataset.num_workers=2",
    ], capture_output=True, text=True, timeout=600, cwd=str(PROJECT_ROOT))

    assert result.returncode == 0, (
        f"main.py failed:\n"
        f"  CWD: {PROJECT_ROOT}\n"
        f"  STDERR:\n{result.stderr}\n"
        f"  STDOUT (last 2000 chars):\n{result.stdout[-2000:]}"
    )

    # Verify weights file was saved to PROJECT_ROOT
    weights_path = PROJECT_ROOT / "weights.pt"
    assert weights_path.exists(), (
        f"No weights.pt found at {weights_path} (expected in subprocess CWD)\n"
        f"  STDOUT (last 2000 chars):\n{result.stdout[-2000:]}"
    )



def test_mnist_classifier_training(tmp_path):
    """main.py trains MNIST classifier for 1 epoch without errors."""
    json_path = FIXTURES_DIR / "mninst_skip.json"
    assert json_path.exists(), f"Fixture not found: {json_path}"

    # Step 1: Convert with num_classes
    cfg_dir = tmp_path / "cfg"
    result = subprocess.run([
        "uv", "run", "python", "src/convert.py",
        str(json_path), str(cfg_dir),
        "--num-classes", "10",
    ], capture_output=True, text=True, timeout=120, cwd=str(PROJECT_ROOT))
    assert result.returncode == 0, (
        f"convert.py failed:\n"
        f"  CMD: uv run python src/convert.py {json_path} {cfg_dir} --num-classes 10\n"
        f"  CWD: {PROJECT_ROOT}\n"
        f"  STDERR:\n{result.stderr}\n"
        f"  STDOUT:\n{result.stdout}"
    )

    # Step 2: Train for 1 epoch
    result = subprocess.run([
        "uv", "run", "python", "src/main.py",
        "--config-path", str(cfg_dir),
        "--config-name", "base",
        "trainer.max_epochs=1",
        "trainer.accelerator=cpu",
        "+trainer.enable_progress_bar=false",
        "+wandb.mode=disabled",
        "dataset.num_workers=2",
    ], capture_output=True, text=True, timeout=600, cwd=str(PROJECT_ROOT))

    assert result.returncode == 0, (
        f"main.py failed:\n"
        f"  CWD: {PROJECT_ROOT}\n"
        f"  STDERR:\n{result.stderr}\n"
        f"  STDOUT (last 2000 chars):\n{result.stdout[-2000:]}"
    )

    # Verify weights file was saved to PROJECT_ROOT
    weights_path = PROJECT_ROOT / "weights.pt"
    assert weights_path.exists(), (
        f"No weights.pt found at {weights_path} (expected in subprocess CWD)\n"
        f"  STDOUT (last 2000 chars):\n{result.stdout[-2000:]}"
    )
