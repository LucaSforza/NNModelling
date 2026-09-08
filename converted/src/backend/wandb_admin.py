"""Administrator-only W&B credential lifecycle commands.

The API key is collected with ``getpass`` and is never accepted as a command
line argument.  Only the validated base URL and entity are printed by this
module.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import httpx

from backend.wandb_credentials import (
    CREDENTIAL_FILE_ENV,
    CredentialError,
    WandbCredentials,
    credential_status,
    delete_credentials,
    save_credentials,
)


DEFAULT_BASE_URL = "https://api.wandb.ai"
DEFAULT_CREDENTIAL_PATH = Path(__file__).resolve().parents[2] / "valkey-data" / "wandb-credentials.json"


def configured_credential_path() -> Path:
    """Return the local credential path selected by the operator."""

    configured = os.getenv(CREDENTIAL_FILE_ENV)
    return Path(configured or DEFAULT_CREDENTIAL_PATH).expanduser()


def verify_credentials(credentials: WandbCredentials) -> None:
    """Verify a W&B API key against its selected Cloud or self-hosted URL.

    Accept only a successful GraphQL response containing a viewer object.  Any
    upstream error body is reduced to a generic administrator error.
    """

    endpoint = f"{credentials.base_url}/graphql"
    query = "query Viewer { viewer { username } }"
    try:
        response = httpx.post(
            endpoint,
            auth=httpx.BasicAuth("api", credentials.api_key),
            json={"query": query},
            timeout=10,
        )
    except httpx.HTTPError as exc:
        raise CredentialError("W&B credential verification failed") from exc
    if response.status_code >= 400:
        raise CredentialError("W&B credential verification failed")
    try:
        payload = response.json()
    except ValueError as exc:
        raise CredentialError("W&B credential verification returned an invalid response") from exc
    if not isinstance(payload, dict) or payload.get("errors"):
        raise CredentialError("W&B credential verification failed")
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("viewer"), dict):
        raise CredentialError("W&B credential verification failed")


def connect(
    path: Path,
    *,
    base_url: str,
    entity: str,
    prompt: Callable[[str], str] | None = None,
    verifier: Callable[[WandbCredentials], None] | None = None,
) -> dict[str, Any]:
    """Prompt, verify, and atomically store shared W&B credentials."""

    api_key = (prompt or getpass.getpass)("W&B API key: ")
    credentials = WandbCredentials.from_mapping(
        {"schema_version": 1, "api_key": api_key, "base_url": base_url, "entity": entity}
    )
    (verifier or verify_credentials)(credentials)
    save_credentials(path, credentials)
    return credential_status(path)


def status(path: Path) -> dict[str, Any]:
    """Return sanitized local credential status."""

    return credential_status(path)


def disconnect(path: Path) -> dict[str, Any]:
    """Remove shared credentials and return sanitized status."""

    delete_credentials(path)
    return credential_status(path)


def build_parser() -> argparse.ArgumentParser:
    """Build the W&B administrator command parser."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credential-file", type=Path, default=configured_credential_path())
    commands = parser.add_subparsers(dest="command", required=True)
    connect_parser = commands.add_parser("connect")
    connect_parser.add_argument("--credential-file", type=Path, default=argparse.SUPPRESS)
    connect_parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    connect_parser.add_argument("--entity", required=True)
    status_parser = commands.add_parser("status")
    status_parser.add_argument("--credential-file", type=Path, default=argparse.SUPPRESS)
    disconnect_parser = commands.add_parser("disconnect")
    disconnect_parser.add_argument("--credential-file", type=Path, default=argparse.SUPPRESS)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run one local W&B administrator command."""

    args = build_parser().parse_args(argv)
    path = args.credential_file
    if args.command == "connect":
        result = connect(path, base_url=args.base_url, entity=args.entity)
    elif args.command == "status":
        result = status(path)
    elif args.command == "disconnect":
        result = disconnect(path)
    else:  # pragma: no cover - argparse guarantees a known command
        raise AssertionError(args.command)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    try:
        raise SystemExit(main())
    except (CredentialError, OSError, httpx.HTTPError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
