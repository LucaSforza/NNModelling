from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, NoServices


class Parameters(TypedDict, total=False):
    d_model: int
    max_len: int


class PositionalEncoding(torch.nn.Module):
    """Add a fixed sinusoidal table to ``[batch, sequence, embedding]`` input."""

    def __init__(self, d_model: int, max_len: int) -> None:
        super().__init__()
        if d_model < 1 or max_len < 1:
            raise ValueError("d_model and max_len must be positive")

        pe = torch.zeros(max_len, d_model, dtype=torch.float32)
        position = torch.arange(max_len, dtype=torch.float32).unsqueeze(1)
        div_term = torch.exp(
            torch.arange(0, d_model, 2, dtype=torch.float32)
            * (-9.210340371976184 / d_model)
        )
        pe[:, 0::2] = torch.sin(position * div_term)
        if d_model > 1:
            pe[:, 1::2] = torch.cos(position * div_term[: pe[:, 1::2].shape[1]])
        self.register_buffer("pe", pe.unsqueeze(0))
        self.d_model = d_model
        self.max_len = max_len

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if x.ndim != 3:
            raise ValueError("Positional Encoding expects a rank-3 input [B, L, D]")
        if not x.is_floating_point():
            raise ValueError("Positional Encoding expects a floating input")
        if x.size(-1) != self.d_model:
            raise ValueError(
                f"Positional Encoding expects embedding dimension {self.d_model}, got {x.size(-1)}"
            )
        if x.size(1) > self.max_len:
            raise ValueError(
                f"Positional Encoding sequence length {x.size(1)} exceeds max_len {self.max_len}"
            )
        return x + self.pe[:, : x.size(1)].to(device=x.device, dtype=x.dtype)


def build(
    parameters: Parameters,
    context: BuildContext,
    services: NoServices,
) -> torch.nn.Module:
    del context, services
    return PositionalEncoding(
        int(parameters.get("d_model", 512)),
        int(parameters.get("max_len", 5000)),
    )
