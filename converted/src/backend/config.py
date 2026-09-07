"""Backend process configuration for dataset archive resource limits."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping

from backend.dataset_store import DatasetArchiveLimits


_SIZE_UNITS = {
    "B": 1,
    "KiB": 1024,
    "MiB": 1024**2,
    "GiB": 1024**3,
}
_SIZE_PATTERN = re.compile(r"([1-9][0-9]*)(B|KiB|MiB|GiB)\Z")


def parse_dataset_size(value: str) -> int:
    """Parse a positive binary byte size with an explicit supported unit."""

    match = _SIZE_PATTERN.fullmatch(value.strip())
    if match is None:
        raise ValueError("dataset size must be a positive integer followed by B, KiB, MiB, or GiB")
    return int(match.group(1)) * _SIZE_UNITS[match.group(2)]


def dataset_limits_from_environment(
    environment: Mapping[str, str] | None = None,
) -> DatasetArchiveLimits:
    """Load defaults plus the legacy compressed-archive environment override."""

    values = os.environ if environment is None else environment
    raw_archive_limit = values.get("NNM_DATASET_MAX_ARCHIVE_BYTES")
    if raw_archive_limit is None:
        return DatasetArchiveLimits()
    try:
        max_archive_bytes = int(raw_archive_limit)
    except ValueError as exc:
        raise ValueError("NNM_DATASET_MAX_ARCHIVE_BYTES must be a positive integer byte count") from exc
    if max_archive_bytes < 1:
        raise ValueError("NNM_DATASET_MAX_ARCHIVE_BYTES must be a positive integer byte count")
    return DatasetArchiveLimits(max_archive_bytes=max_archive_bytes)
