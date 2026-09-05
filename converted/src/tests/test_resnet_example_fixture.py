"""Static contract checks for the canonical package-format ResNet example."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
import struct

ROOT = Path(__file__).parents[3]
RESNET = ROOT / "examples" / "diagrams" / "package" / "models" / "resnet"
DATASET = RESNET / "datasets" / "resnet-mnist"


def _json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_resnet_fixture_uses_named_image_and_label_contract() -> None:
    model = _json(RESNET / "model.json")
    dataset = _json(DATASET / "dataset.json")
    input_node = next(node for node in model["nodes"] if node["id"] == "image")

    assert input_node["data"]["params"] == {"binding": "image"}
    assert model["manifest"]["customDatasets"] == [{
        "id": "example.resnet-mnist",
        "version": "0.1.0",
        "path": "datasets/resnet-mnist",
    }]
    assert dataset["batch"]["inputs"]["image"] == {"shape": ["B", 1, 28, 28], "dtype": "float32"}
    assert dataset["batch"]["targets"]["target"] == {"shape": ["B"], "dtype": "int64"}


def test_resnet_fixture_contains_matching_mnist_archives() -> None:
    expected = {
        "train-images-idx3-ubyte.gz": (2051, 60000),
        "train-labels-idx1-ubyte.gz": (2049, 60000),
        "t10k-images-idx3-ubyte.gz": (2051, 10000),
        "t10k-labels-idx1-ubyte.gz": (2049, 10000),
    }
    for name, (magic, count) in expected.items():
        with gzip.open(DATASET / "data" / name, "rb") as archive:
            header = archive.read(16 if magic == 2051 else 8)
        values = struct.unpack(">IIII", header)[:2] if magic == 2051 else struct.unpack(">II", header)
        assert values == (magic, count)
