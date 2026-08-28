from __future__ import annotations

import pytest

from predict_digit import predict_digit


class FakeModel:
    def __init__(self, output: object) -> None:
        self.output = output

    def predict(self, value: object) -> object:
        del value
        return self.output


def test_predict_digit_returns_top_class_and_probabilities(tmp_path):
    image_path = tmp_path / "digit.png"
    image_path.write_bytes(b"not inspected by the fake model")

    result = predict_digit(FakeModel([[1.0, 2.0, 9.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]]), image_path)

    assert result["digit"] == 2
    assert result["top3"][0]["digit"] == 2
    assert result["confidence"] == pytest.approx(result["top3"][0]["probability"])


def test_predict_digit_rejects_wrong_number_of_classes(tmp_path):
    image_path = tmp_path / "digit.png"
    image_path.write_bytes(b"not inspected by the fake model")

    with pytest.raises(ValueError, match="expected 10"):
        predict_digit(FakeModel([1.0, 2.0]), image_path)
