"""Command-line entrypoint for the NNModelling training backend."""

from __future__ import annotations

import argparse
from collections.abc import Sequence

import uvicorn

from backend.config import dataset_limits_from_environment, parse_dataset_size
from backend.dataset_store import DatasetArchiveLimits


def build_parser() -> argparse.ArgumentParser:
    """Build the backend process argument parser."""

    parser = argparse.ArgumentParser(description="Run the NNModelling training backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    size_group = parser.add_mutually_exclusive_group()
    size_group.add_argument(
        "--max-dataset-size",
        type=_dataset_size_argument,
        metavar="SIZE",
        help="limit compressed archive, each file, and total expanded data (B/KiB/MiB/GiB)",
    )
    size_group.add_argument(
        "--unsafe-unlimited-dataset-size",
        action="store_true",
        help="disable all dataset byte limits; path, metadata and file-count checks remain enabled",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    """Run Uvicorn with CLI limits taking precedence over the environment."""

    args = build_parser().parse_args(argv)
    limits = _dataset_limits(args.max_dataset_size, args.unsafe_unlimited_dataset_size)
    from backend.app import create_app

    uvicorn.run(create_app(dataset_limits=limits), host=args.host, port=args.port)


def _dataset_size_argument(value: str) -> int:
    try:
        return parse_dataset_size(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def _dataset_limits(max_dataset_size: int | None, unsafe_unlimited: bool) -> DatasetArchiveLimits:
    if unsafe_unlimited:
        return DatasetArchiveLimits.unsafe_unlimited_size()
    if max_dataset_size is not None:
        return DatasetArchiveLimits.uniform_size_limit(max_dataset_size)
    return dataset_limits_from_environment()


if __name__ == "__main__":  # pragma: no cover
    main()
