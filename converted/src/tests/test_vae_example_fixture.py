"""Static contract checks for the canonical package-format VAE example."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).parents[3]
VAE = ROOT / "examples" / "diagrams" / "package" / "models" / "variational-autoencoder"
DATASET = VAE / "datasets" / "autoencoder-mnist"


def _json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_vae_fixture_uses_dataset_input_contract() -> None:
    model = _json(VAE / "model.json")
    dataset = _json(DATASET / "dataset.json")
    input_node = next(node for node in model["nodes"] if node["id"] == "input")

    assert input_node["data"]["inputBinding"] == "image"
    assert input_node["data"]["params"] == {}
    assert "inferenceAdapter" not in dataset

    parameters = {parameter["name"]: parameter for parameter in dataset["parameters"]}
    assert parameters["B"] == {"name": "B", "type": "integer", "required": True}
    assert dataset["batch"]["inputs"]["image"] == {
        "shape": ["B", 1, 28, 28],
        "dtype": "float32",
    }
    assert dataset["batch"]["targets"]["target"] == {
        "shape": ["B", 1, 28, 28],
        "dtype": "float32",
    }

    # This is the concrete example selection used by the training workflow.
    selection = {"B": 32, "num_workers": 0, "train_size": 0.8}
    assert selection["B"] > 0
    for slot in (*dataset["batch"]["inputs"].values(), *dataset["batch"]["targets"].values()):
        assert [selection.get(dimension, dimension) for dimension in slot["shape"]] == [32, 1, 28, 28]


def test_vae_fixture_keeps_latent_paths_on_declared_model_adapters() -> None:
    model = _json(VAE / "model.json")
    nodes = {node["id"]: node for node in model["nodes"]}

    assert nodes["encoder"]["data"]["wheelAdapters"] == ["encode"]
    assert nodes["decoder"]["data"]["wheelAdapters"] == ["forward"]
    assert nodes["sample-z"]["data"]["wheelAdapters"] == ["sample"]
    assert all("inferenceAdapter" not in node["data"] for node in model["nodes"])
