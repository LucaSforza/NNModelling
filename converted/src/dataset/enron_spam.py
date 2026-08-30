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
from torch.utils.data import DataLoader, random_split
import torch
from transformers import AutoTokenizer, DataCollatorWithPadding
from datasets import load_dataset
from collections.abc import Mapping
from typing import Any

from dataset.contracts import (
    DatasetBatchContract,
    DatasetClassMetadata,
    DatasetContext,
    DatasetDefinition,
    DatasetParameter,
    DatasetSourceManifest,
    TensorSlotContract,
)
from dataset.ds import Dataset, named_batch


ENRON_SPAM_DATASET_ID = "builtin.enron-spam"
ENRON_SPAM_DATASET_VERSION = "1.0.0"
ENRON_SPAM_DATASET_REF = "builtin_enron_spam"
ENRON_SPAM_MANIFEST = DatasetSourceManifest(
    schemaVersion=1,
    id=ENRON_SPAM_DATASET_ID,
    version=ENRON_SPAM_DATASET_VERSION,
    entrypoints={"definition": "dataset.json", "python": "dataset.py"},
)
ENRON_SPAM_DEFINITION = DatasetDefinition(
    schemaVersion=1,
    id=ENRON_SPAM_DATASET_ID,
    version=ENRON_SPAM_DATASET_VERSION,
    name="Enron Spam",
    description="Two-class Enron email spam classification dataset.",
    parameters=(
        DatasetParameter(name="model_name", type="string", default="bert-base-uncased"),
        DatasetParameter(name="batch_size", type="integer", default=32),
        DatasetParameter(name="train_size", type="number", default=0.8),
        DatasetParameter(name="num_workers", type="integer", default=0),
        DatasetParameter(name="max_length", type="integer", default=128),
    ),
    batch=DatasetBatchContract(
        inputs={
            "input_ids": TensorSlotContract(shape=("B", "T"), dtype="int64"),
            "attention_mask": TensorSlotContract(shape=("B", "T"), dtype="int64"),
        },
        targets={"label": TensorSlotContract(shape=("B",), dtype="int64")},
    ),
    classes=DatasetClassMetadata(count=2, names=("ham", "spam")),
    inferenceAdapter={"kind": "text", "version": 1, "model_name": "bert-base-uncased", "max_length": 128},
)


class EnronSpamDataset(Dataset):
    """Text classification dataset: SetFit/enron_spam.

    Tokenizes with HF AutoTokenizer. Uses DataCollatorWithPadding.
    division() returns DataLoaders yielding named ``TrainingBatch`` values.
    """

    @classmethod
    def definition(cls) -> DatasetDefinition:
        return ENRON_SPAM_DEFINITION

    @classmethod
    def num_classes(cls, config: dict[str, Any]) -> int:
        """Return the ham/spam label cardinality without downloading the corpus."""

        del config
        return 2

    @classmethod
    def class_names(cls, config: dict[str, Any]) -> list[str]:
        """Return label names in the order used by SetFit/enron_spam."""

        del config
        return ["ham", "spam"]

    @classmethod
    def inference_adapter_spec(cls, config: dict[str, Any]) -> dict[str, Any]:
        """Describe BERT tokenization needed to infer from one raw email."""

        model_name = config.get("model_name", "bert-base-uncased")
        max_length = config.get("max_length", 128)
        if not isinstance(model_name, str) or not model_name:
            raise ValueError("EnronSpamDataset model_name must be a non-empty string")
        if not isinstance(max_length, int) or max_length < 1:
            raise ValueError("EnronSpamDataset max_length must be a positive integer")
        return {
            "kind": "text",
            "version": 1,
            "model_name": model_name,
            "max_length": max_length,
        }

    def __init__(
        self,
        model_name: str = "bert-base-uncased",
        batch_size: int = 32,
        train_size: float = 0.8,
        num_workers: int = 0,
        max_length: int = 128,
    ):
        super().__init__()
        self.batch_size = batch_size
        self.train_size = train_size
        self.num_workers = num_workers

        raw = load_dataset("SetFit/enron_spam")
        self.tokenizer = AutoTokenizer.from_pretrained(model_name)
        self.collator = DataCollatorWithPadding(tokenizer=self.tokenizer)

        def tokenize_fn(examples):
            return self.tokenizer(
                examples["text"], truncation=True, max_length=max_length
            )

        tokenized = raw.map(tokenize_fn, batched=True)
        # Remove all original columns, keep only tokenizer outputs + label
        keep = {"label", "input_ids", "attention_mask"}
        remove_cols = [c for c in tokenized["train"].column_names if c not in keep]
        tokenized = tokenized.remove_columns(remove_cols)
        tokenized = tokenized.rename_column("label", "labels")

        self.train_dataset = tokenized["train"]
        self.test_dataset = tokenized["test"]

    def __getitem__(self, index):
        return self.train_dataset[index]

    def __len__(self):
        return len(self.train_dataset)

    def _collate(self, batch):
        padded = self.collator(batch)
        return named_batch(
            {"input_ids": padded["input_ids"], "attention_mask": padded["attention_mask"]},
            {"label": padded["labels"].to(dtype=torch.int64)},
        )

    def division(self) -> tuple[DataLoader, DataLoader, DataLoader]:
        train_len = int(len(self.train_dataset) * self.train_size)
        val_len = len(self.train_dataset) - train_len
        train_sub, val_sub = random_split(self.train_dataset, [train_len, val_len])

        train_loader = DataLoader(
            train_sub,
            batch_size=self.batch_size,
            shuffle=True,
            collate_fn=self._collate,
            num_workers=self.num_workers,
        )
        val_loader = DataLoader(
            val_sub,
            batch_size=self.batch_size,
            shuffle=False,
            collate_fn=self._collate,
            num_workers=self.num_workers,
        )
        test_loader = DataLoader(
            self.test_dataset,
            batch_size=self.batch_size,
            shuffle=False,
            collate_fn=self._collate,
            num_workers=self.num_workers,
        )

        return train_loader, val_loader, test_loader


def validate_parameters(parameters: Mapping[str, object]) -> dict[str, object]:
    """Validate Enron's fixed primitive parameter contract."""

    result = dict(parameters)
    model_name = result.get("model_name", "bert-base-uncased")
    batch_size = result.get("batch_size", 32)
    train_size = result.get("train_size", 0.8)
    num_workers = result.get("num_workers", 0)
    max_length = result.get("max_length", 128)
    if not isinstance(model_name, str) or not model_name:
        raise ValueError("model_name must be a non-empty string")
    if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size < 1:
        raise ValueError("batch_size must be a positive integer")
    if isinstance(train_size, bool) or not isinstance(train_size, (int, float)) or not 0 < train_size <= 1:
        raise ValueError("train_size must be greater than 0 and at most 1")
    if isinstance(num_workers, bool) or not isinstance(num_workers, int) or num_workers < 0:
        raise ValueError("num_workers must be a non-negative integer")
    if isinstance(max_length, bool) or not isinstance(max_length, int) or max_length < 1:
        raise ValueError("max_length must be a positive integer")
    if "train_size" in result:
        result["train_size"] = float(train_size)
    return result


def build(parameters: Mapping[str, object], context: DatasetContext) -> EnronSpamDataset:
    """Fixed builder for the trusted operator-owned Enron dataset."""

    del context
    return EnronSpamDataset(**validate_parameters(parameters))
