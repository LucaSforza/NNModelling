"""Offline Enron Spam dataset adapter for the transformer.spam project."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import json
from pathlib import Path
import random
import re
from typing import Any

import torch
from torch.utils.data import DataLoader, Dataset


SEQUENCE_LENGTH = 128
VOCABULARY_SIZE = 128
PAD_TOKEN = "<pad>"
UNKNOWN_TOKEN = "<unk>"
TOKEN_PATTERN = re.compile(r"\w+|[^\w\s]", re.UNICODE)


@dataclass(frozen=True)
class DatasetContext:
    """Read-only resources supplied by the isolated dataset worker."""

    resource_root: Path
    reference: Any | None = None


@dataclass(frozen=True)
class TrainingBatch:
    """Flat named tensor maps consumed by the compiled model."""

    inputs: Mapping[str, torch.Tensor]
    targets: Mapping[str, torch.Tensor]


@dataclass(frozen=True)
class TextExample:
    """One normalized text example and its binary class index."""

    text: str
    label: int


class EncodedTextDataset(Dataset[tuple[torch.Tensor, int]]):
    """Tokenized examples kept on CPU until a worker consumes a batch."""

    def __init__(self, examples: Sequence[TextExample], vocabulary: Mapping[str, int]) -> None:
        self._examples = list(examples)
        self._vocabulary = vocabulary

    def __len__(self) -> int:
        return len(self._examples)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, int]:
        return _encode(self._examples[index], self._vocabulary)


class ProjectDataset:
    """Expose deterministic train, validation and test DataLoaders."""

    def __init__(self, splits: Mapping[str, DataLoader[TrainingBatch]]) -> None:
        self._splits = dict(splits)

    def division(self) -> Mapping[str, DataLoader[TrainingBatch]]:
        """Return the dataset divisions expected by the worker."""

        return self._splits


def _read_jsonl(path: Path) -> list[TextExample]:
    """Read the prepared Enron JSONL split without network or pandas."""

    if not path.is_file():
        raise FileNotFoundError(f"missing Enron split: {path.name}")

    examples: list[TextExample] = []
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSON in {path.name} at line {line_number}") from exc
            if not isinstance(record, Mapping):
                raise TypeError(f"record in {path.name} at line {line_number} must be an object")

            text = record.get("text")
            if not isinstance(text, str) or not text.strip():
                subject = record.get("subject", "")
                message = record.get("message", "")
                if not isinstance(subject, str) or not isinstance(message, str):
                    raise TypeError(f"record in {path.name} at line {line_number} has invalid text fields")
                text = f"{subject} {message}".strip()
            if not text:
                # Empty Enron records carry no signal and are omitted from the split.
                continue

            label = record.get("label")
            if isinstance(label, bool) or not isinstance(label, int):
                label_text = record.get("label_text")
                label = {"ham": 0, "spam": 1}.get(label_text)
            if label not in (0, 1):
                raise ValueError(f"record in {path.name} at line {line_number} has an invalid label")
            examples.append(TextExample(text=text, label=label))

    if not examples:
        raise ValueError(f"Enron split is empty: {path.name}")
    return examples


def _tokens(text: str) -> list[str]:
    """Apply the small deterministic tokenizer used by this model."""

    return TOKEN_PATTERN.findall(text.casefold())


def _build_vocabulary(examples: Sequence[TextExample]) -> dict[str, int]:
    """Build a bounded train-only vocabulary compatible with Embedding(128)."""

    counts = Counter(token for example in examples for token in _tokens(example.text))
    vocabulary = {PAD_TOKEN: 0, UNKNOWN_TOKEN: 1}
    for token, _count in counts.most_common(VOCABULARY_SIZE - len(vocabulary)):
        vocabulary[token] = len(vocabulary)
    return vocabulary


def _encode(example: TextExample, vocabulary: Mapping[str, int]) -> tuple[torch.Tensor, int]:
    """Encode one message to an int32 tensor of exactly 128 token IDs."""

    token_ids = [vocabulary.get(token, vocabulary[UNKNOWN_TOKEN]) for token in _tokens(example.text)]
    token_ids = token_ids[:SEQUENCE_LENGTH]
    token_ids.extend([vocabulary[PAD_TOKEN]] * (SEQUENCE_LENGTH - len(token_ids)))
    return torch.tensor(token_ids, dtype=torch.int32), example.label


def _split_validation(examples: Sequence[TextExample]) -> tuple[list[TextExample], list[TextExample]]:
    """Create a reproducible, approximately stratified validation split."""

    randomizer = random.Random(42)
    validation_indices: set[int] = set()
    for label in (0, 1):
        indices = [index for index, example in enumerate(examples) if example.label == label]
        randomizer.shuffle(indices)
        validation_count = max(1, len(indices) // 10)
        validation_indices.update(indices[:validation_count])

    train = [example for index, example in enumerate(examples) if index not in validation_indices]
    validation = [example for index, example in enumerate(examples) if index in validation_indices]
    if not train or not validation:
        raise ValueError("Enron train split is too small to create train and validation divisions")
    return train, validation


def _collate(examples: list[tuple[torch.Tensor, int]]) -> dict[str, dict[str, torch.Tensor]]:
    """Batch encoded prompts and emit one-hot float32 class targets."""

    prompt = torch.stack([item[0] for item in examples]).to(dtype=torch.int32)
    labels = torch.tensor([item[1] for item in examples], dtype=torch.int64)
    targets = torch.zeros((len(examples), 2), dtype=torch.float32)
    targets.scatter_(1, labels.unsqueeze(1), 1.0)
    return {"inputs": {"features": prompt}, "targets": {"target": targets}}


def _loader(
    examples: Sequence[TextExample],
    vocabulary: Mapping[str, int],
    batch_size: int,
    *,
    shuffle: bool,
) -> DataLoader[TrainingBatch]:
    encoded = EncodedTextDataset(examples, vocabulary)
    generator = torch.Generator().manual_seed(42) if shuffle else None
    return DataLoader(
        encoded,
        batch_size=batch_size,
        shuffle=shuffle,
        generator=generator,
        collate_fn=_collate,
        drop_last=True,
        num_workers=0,
    )


def build(parameters: Mapping[str, object], context: DatasetContext) -> ProjectDataset:
    """Build the offline Enron dataset from files shipped in the project archive."""

    raw_batch_size = parameters.get("B")
    if isinstance(raw_batch_size, bool) or not isinstance(raw_batch_size, int) or raw_batch_size <= 0:
        raise ValueError("dataset parameter B must be a positive integer")

    data_root = context.resource_root / "data"
    train_examples = _read_jsonl(data_root / "train.jsonl")
    test_examples = _read_jsonl(data_root / "test.jsonl")
    train_examples, validation_examples = _split_validation(train_examples)
    vocabulary = _build_vocabulary(train_examples)

    return ProjectDataset({
        "train": _loader(train_examples, vocabulary, raw_batch_size, shuffle=True),
        "validation": _loader(validation_examples, vocabulary, raw_batch_size, shuffle=False),
        "test": _loader(test_examples, vocabulary, raw_batch_size, shuffle=False),
    })


# Declared input slots: features
# Declared target slots: target
