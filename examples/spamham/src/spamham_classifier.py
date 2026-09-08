"""Command-line consumer for the generated spam/ham model wheel."""

from __future__ import annotations

import re
import sys

import torch
from nnm_spamham import Model


SEQUENCE_LENGTH = 128
TOKEN_PATTERN = re.compile(r"\w+|[^\w\s]", re.UNICODE)
LABELS = ("ham", "spam")
VOCABULARY = {
    token: index
    for index, token in enumerate(
        (
            "<pad>", "<unk>", ".", "-", ",", "the", "to", "/", ":", "and", "of", "a", "in", "for",
            "you", "'", "is", "_", "this", "enron", "on", "that", "i", ")", "?", "(", "s", '"', "with",
            "your", "@", "be", "we", "!", "$", "as", "from", "have", "it", "will", ">", "are", "or", "ect",
            "at", "by", "not", ";", "our", "com", "*", "if", "1", "company", "|", "all", "please", "an",
            "2", "has", "=", "can", "3", "was", "hou", "any", "me", "2001", "e", "would", "new", "no",
            "its", "more", "%", "10", "2000", "subject", "my", "am", "but", "5", "may", "&", "information",
            "t", "do", "which", "re", "00", "time", "business", "about", "up", "been", "said", "one", "gas",
            "out", "they", "energy", "us", "0", "http", "4", "get", "here", "email", "he", "000", "their",
            "pm", "message", "price", "11", "these", "there", "know", "now", "01", "cc", "also", "other",
            "only", "so", "need", "mail", "over",
        )
    )
}


def encode(prompt: str) -> torch.Tensor:
    """Encode one prompt exactly as the training dataset encoded messages."""

    unknown = VOCABULARY["<unk>"]
    token_ids = [VOCABULARY.get(token, unknown) for token in TOKEN_PATTERN.findall(prompt.casefold())]
    token_ids = token_ids[:SEQUENCE_LENGTH]
    token_ids.extend([VOCABULARY["<pad>"]] * (SEQUENCE_LENGTH - len(token_ids)))
    return torch.tensor([token_ids], dtype=torch.int32)


def classify(prompt: str) -> str:
    """Return the class label predicted for one prompt."""

    scores = Model().predict_tensor(encode(prompt))
    return LABELS[int(scores.argmax(dim=-1).item())]


def main() -> None:
    """Print only the predicted class for the single CLI prompt."""

    if len(sys.argv) != 2:
        raise SystemExit("usage: spamham-classify PROMPT")
    print(classify(sys.argv[1]))
