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
"""Inference validation tests: convert -> train 1 epoch -> infer -> validate JSON output.

NOTE: main.py saves weights.pt to the subprocess CWD (PROJECT_ROOT / "converted/"),
not to hydra.run.dir. This is because Hydra creates the output directory structure
(.hydra/, main.log) but the app process runs from the original CWD.

infer.py resolves --weights relative to project_root (= "converted/"), so passing
--weights weights.pt correctly finds the file at converted/weights.pt.
"""

import subprocess
import json
from pathlib import Path
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent  # converted/
FIXTURES_DIR = PROJECT_ROOT.parent / "examples" / "nntrees"


@pytest.fixture(autouse=True)
def clean_inference_artifacts():
    """Keep subprocess checkpoints out of the repository after every test."""
    yield
    for filename in ("weights.pt", "weights.safetensors"):
        artifact = PROJECT_ROOT / filename
        if artifact.exists():
            artifact.unlink()


def test_autoencoder_inference(tmp_path):
    """Full pipeline: convert -> train 1 epoch -> infer -> validate output."""
    json_path = FIXTURES_DIR / "auto_encoder.json"
    assert json_path.exists(), f"Fixture not found: {json_path}"

    # 1. Convert with autoencoder dataset
    cfg_dir = tmp_path / "cfg"
    result = subprocess.run([
        "uv", "run", "python", "src/convert.py",
        str(json_path), str(cfg_dir),
        "--dataset", "dataset.autoencoder_mnist.AutoencoderMNIST",
    ], capture_output=True, text=True, timeout=120, cwd=str(PROJECT_ROOT))
    assert result.returncode == 0, (
        f"convert.py failed:\nSTDERR:\n{result.stderr}\nSTDOUT:\n{result.stdout}"
    )

    # 2. Train for 1 epoch (weights.pt lands in PROJECT_ROOT)
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
        f"main.py failed:\nSTDERR:\n{result.stderr}\nSTDOUT (last 2000):\n{result.stdout[-2000:]}"
    )

    # 3. Verify checkpoint exists
    weights_path = PROJECT_ROOT / "weights.pt"
    assert weights_path.exists(), f"No weights.pt found at {weights_path}"

    try:
        # 4. Run inference
        output_path = tmp_path / "predictions.json"
        result = subprocess.run([
            "uv", "run", "python", "src/infer.py",
            "--config-path", str(cfg_dir),
            "--config-name", "base",
            "--weights", "weights.pt",
            "--output", str(output_path),
        ], capture_output=True, text=True, timeout=300, cwd=str(PROJECT_ROOT))
        assert result.returncode == 0, (
            f"infer.py failed:\nSTDERR:\n{result.stderr}\nSTDOUT (last 2000):\n{result.stdout[-2000:]}"
        )

        # 5. Validate predictions JSON
        assert output_path.exists(), f"Output file not found: {output_path}"
        predictions = json.loads(output_path.read_text())
        assert isinstance(predictions, list), f"Expected list, got {type(predictions)}"
        assert len(predictions) > 0, "Predictions list is empty"

        # Autoencoder predictions have "input", "target", "prediction" keys
        first = predictions[0]
        assert "input" in first, "Missing 'input' key in prediction entry"
        assert "target" in first, "Missing 'target' key in prediction entry"
        assert "prediction" in first, "Missing 'prediction' key in prediction entry"
    finally:
        # The autouse fixture also removes the safetensors artifact emitted by
        # main.py, including when inference itself fails.
        if weights_path.exists():
            weights_path.unlink()


def test_mnist_classifier_inference(tmp_path):
    """Full pipeline for MNIST classifier: convert -> train -> infer."""
    json_path = FIXTURES_DIR / "mninst_skip.json"
    assert json_path.exists(), f"Fixture not found: {json_path}"

    # 1. Convert with num_classes
    cfg_dir = tmp_path / "cfg"
    result = subprocess.run([
        "uv", "run", "python", "src/convert.py",
        str(json_path), str(cfg_dir),
        "--num-classes", "10",
    ], capture_output=True, text=True, timeout=120, cwd=str(PROJECT_ROOT))
    assert result.returncode == 0, (
        f"convert.py failed:\nSTDERR:\n{result.stderr}\nSTDOUT:\n{result.stdout}"
    )

    # 2. Train for 1 epoch (weights.pt lands in PROJECT_ROOT)
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
        f"main.py failed:\nSTDERR:\n{result.stderr}\nSTDOUT (last 2000):\n{result.stdout[-2000:]}"
    )

    # 3. Verify checkpoint exists
    weights_path = PROJECT_ROOT / "weights.pt"
    assert weights_path.exists(), f"No weights.pt found at {weights_path}"

    try:
        # 4. Run inference
        output_path = tmp_path / "predictions.json"
        result = subprocess.run([
            "uv", "run", "python", "src/infer.py",
            "--config-path", str(cfg_dir),
            "--config-name", "base",
            "--weights", "weights.pt",
            "--output", str(output_path),
        ], capture_output=True, text=True, timeout=300, cwd=str(PROJECT_ROOT))
        assert result.returncode == 0, (
            f"infer.py failed:\nSTDERR:\n{result.stderr}\nSTDOUT (last 2000):\n{result.stdout[-2000:]}"
        )

        # 5. Validate predictions JSON
        assert output_path.exists(), f"Output file not found: {output_path}"
        predictions = json.loads(output_path.read_text())
        assert isinstance(predictions, list), f"Expected list, got {type(predictions)}"
        assert len(predictions) > 0, "Predictions list is empty"

        # Classifier predictions have "input", "target", "prediction" keys
        first = predictions[0]
        assert "input" in first, "Missing 'input' key in prediction entry"
        assert "target" in first, "Missing 'target' key in prediction entry"
        assert "prediction" in first, "Missing 'prediction' key in prediction entry"
    finally:
        if weights_path.exists():
            weights_path.unlink()
