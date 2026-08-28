from typing import TypedDict

import torch

from stereotype_runtime.pytorch import BuildContext, DType, NoServices, torch_dtype


class Parameters(TypedDict):
    num_embeddings: int
    embedding_dim: int
    input_dtype: DType
    dtype: DType


def build(
    parameters: Parameters,
    context: BuildContext,
    services: NoServices,
) -> torch.nn.Module:
    return torch.nn.Embedding(
        parameters["num_embeddings"],
        parameters["embedding_dim"],
        dtype=torch_dtype(context["output"]["dtype"]),
    )
