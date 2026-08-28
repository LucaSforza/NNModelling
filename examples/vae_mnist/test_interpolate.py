from pathlib import Path

import pytest
import torch
from PIL import Image

from interpolate import _encoder_tensor, _grid, _prediction_image


class _InputAdapter:
    def to_tensor(self, _path: Path) -> torch.Tensor:
        return torch.zeros((1, 1, 28, 28))


class _Model:
    input_adapter = _InputAdapter()


def test_fixture_adapter_output_is_flattened_for_encoder(tmp_path: Path):
    fixture = tmp_path / "digit.png"
    Image.new("L", (28, 28), color=0).save(fixture)
    tensor = _encoder_tensor(_Model(), fixture)
    assert tensor.shape == (1, 784)
    assert tensor.dtype is torch.float32


def test_prediction_and_grid_shapes():
    image = _prediction_image(torch.zeros(784))
    assert image.size == (28, 28)
    assert _grid([image, image]).size == (56, 28)


def test_invalid_shapes_are_rejected():
    with pytest.raises(ValueError, match="decoded image"):
        _prediction_image(torch.zeros(28, 28))
