"""Declarative, trusted input adapters for exported inference models."""

from __future__ import annotations

from collections.abc import Mapping
from io import BytesIO
from pathlib import Path
from typing import Any, Protocol

import torch


class InputAdapter(Protocol):
    """Convert one user-facing value to a model input tensor."""

    def to_tensor(self, value: object) -> torch.Tensor:
        """Return a tensor suitable for the exported model."""


class TensorAdapter:
    """Universal adapter for callers that already have model-ready tensors."""

    def to_tensor(self, value: object) -> torch.Tensor:
        """Validate and return a tensor without changing its shape."""

        if not isinstance(value, torch.Tensor):
            raise TypeError("TensorAdapter expects a torch.Tensor; use predict_tensor for batch tensors")
        return value


class ImageAdapter:
    """Convert a file path, bytes, or PIL image into a normalized batch tensor."""

    def __init__(
        self,
        *,
        channels: int,
        size: list[int],
        mean: list[float],
        std: list[float],
    ) -> None:
        self.channels = channels
        self.size = size
        self.mean = mean
        self.std = std

    def to_tensor(self, value: object) -> torch.Tensor:
        """Normalize one image and add its batch dimension."""

        try:
            from PIL import Image
            from torchvision.transforms import functional as transform
        except ImportError as exc:  # pragma: no cover - depends on consumer extras
            raise RuntimeError("Image inference requires Pillow and torchvision") from exc
        if isinstance(value, (str, Path)):
            with Image.open(value) as opened:
                image = opened.copy()
        elif isinstance(value, bytes):
            with Image.open(BytesIO(value)) as opened:
                image = opened.copy()
        elif isinstance(value, Image.Image):
            image = value
        else:
            raise TypeError("ImageAdapter expects a path, bytes, or PIL.Image.Image")
        mode = "L" if self.channels == 1 else "RGB"
        tensor = transform.to_tensor(transform.resize(image.convert(mode), self.size))
        tensor = transform.normalize(tensor, mean=self.mean, std=self.std)
        return tensor.unsqueeze(0)


class TextAdapter:
    """Tokenize one text value into the input IDs expected by a text model."""

    def __init__(self, *, model_name: str, max_length: int) -> None:
        try:
            from transformers import AutoTokenizer
        except ImportError as exc:  # pragma: no cover - depends on consumer extras
            raise RuntimeError("Text inference requires transformers") from exc
        self.max_length = max_length
        self.tokenizer = AutoTokenizer.from_pretrained(model_name)

    def to_tensor(self, value: object) -> torch.Tensor:
        """Tokenize one email and return a padded batch of input IDs."""

        if not isinstance(value, str):
            raise TypeError("TextAdapter expects a string")
        encoded = self.tokenizer(
            value,
            return_tensors="pt",
            truncation=True,
            max_length=self.max_length,
            padding="max_length",
        )
        return encoded["input_ids"]


def adapter_from_spec(spec: Mapping[str, Any]) -> InputAdapter:
    """Construct an adapter exclusively from the supported declarative registry."""

    kind = spec.get("kind")
    if kind == "tensor":
        return TensorAdapter()
    if kind == "image":
        return ImageAdapter(
            channels=_integer(spec, "channels"),
            size=_number_list(spec, "size"),
            mean=_number_list(spec, "mean"),
            std=_number_list(spec, "std"),
        )
    if kind == "text":
        return TextAdapter(
            model_name=_string(spec, "model_name"),
            max_length=_integer(spec, "max_length"),
        )
    raise ValueError(f"unsupported input adapter kind: {kind!r}")


def adapter_spec_from_definition(definition: Mapping[str, Any]) -> dict[str, Any]:
    """Return the explicitly declared adapter from a dataset definition."""
    spec = definition.get("inferenceAdapter")
    if spec is None:
        return {"kind": "tensor", "version": 1}
    if not isinstance(spec, Mapping):
        raise TypeError("dataset inferenceAdapter must be an object")
    return dict(spec)


def _integer(spec: Mapping[str, Any], name: str) -> int:
    value = spec.get(name)
    if not isinstance(value, int):
        raise ValueError(f"image adapter field {name!r} must be an integer")
    return value


def _number_list(spec: Mapping[str, Any], name: str) -> list[float] | list[int]:
    value = spec.get(name)
    if not isinstance(value, list) or not all(isinstance(item, (int, float)) for item in value):
        raise ValueError(f"image adapter field {name!r} must be a numeric list")
    return value


def _string(spec: Mapping[str, Any], name: str) -> str:
    value = spec.get(name)
    if not isinstance(value, str) or not value:
        raise ValueError(f"text adapter field {name!r} must be a non-empty string")
    return value
