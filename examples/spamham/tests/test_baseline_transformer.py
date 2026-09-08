from __future__ import annotations

import torch

from baseline_transformer import TransformerSpamClassifier, _batches, set_seed


def test_model_matches_spamham_shape_and_parameter_count() -> None:
    model = TransformerSpamClassifier()
    logits = model(torch.zeros((3, 128), dtype=torch.int32))

    assert logits.shape == (3, 2)
    assert sum(parameter.numel() for parameter in model.parameters() if parameter.requires_grad) == 413_186
    assert not model.position.requires_grad


def test_seed_reproduces_model_initialization() -> None:
    set_seed(42)
    first = TransformerSpamClassifier()
    set_seed(42)
    second = TransformerSpamClassifier()

    assert all(torch.equal(left, right) for left, right in zip(first.parameters(), second.parameters()))


def test_batch_adapter_converts_one_hot_targets() -> None:
    batch = {"inputs": {"features": torch.zeros((2, 128), dtype=torch.int32)}, "targets": {"target": torch.tensor([[1.0, 0.0], [0.0, 1.0]])}}

    features, labels = next(_batches([batch]))

    assert features.dtype == torch.int32
    assert labels.tolist() == [0, 1]
