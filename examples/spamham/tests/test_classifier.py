from spamham_classifier import encode


def test_encode_produces_wheel_input_contract() -> None:
    encoded = encode("Prompt passed to the transformer")

    assert encoded.shape == (1, 128)
    assert str(encoded.dtype) == "torch.int32"
