"""Local W&B credential storage and the worker stdin protocol.

The credential file is an administrator-owned machine-local secret.  This
module deliberately keeps the secret out of status documents and error text so
the same parser can be used by the administrator CLI and by the package worker.
"""

from __future__ import annotations

import json
import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Mapping
from typing import Any, BinaryIO, TextIO
from urllib.parse import urlsplit, urlunsplit


CREDENTIAL_SCHEMA_VERSION = 1
MAX_CREDENTIAL_BYTES = 16 * 1024
CREDENTIAL_FILE_ENV = "NNM_WANDB_CREDENTIAL_FILE"
_CREDENTIAL_FIELDS = frozenset({"schema_version", "api_key", "base_url", "entity"})


class CredentialError(ValueError):
    """Raised when a W&B credential document is invalid or unavailable."""


@dataclass(frozen=True, repr=False)
class WandbCredentials:
    """Validated credentials for the shared W&B account.

    The custom representation is intentional: accidental debug output must
    never include the API key.
    """

    api_key: str
    base_url: str
    entity: str

    def __repr__(self) -> str:
        """Return a representation that omits the secret value."""

        return f"WandbCredentials(base_url={self.base_url!r}, entity={self.entity!r}, api_key=<redacted>)"

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "WandbCredentials":
        """Validate the frozen versioned credential JSON shape."""

        if not isinstance(value, Mapping):
            raise CredentialError("W&B credentials must be a JSON object")
        if set(value) != _CREDENTIAL_FIELDS:
            raise CredentialError("W&B credentials contain an unsupported field set")
        schema_version = value.get("schema_version")
        if isinstance(schema_version, bool) or schema_version != CREDENTIAL_SCHEMA_VERSION:
            raise CredentialError("unsupported W&B credential schema version")
        api_key = _text_field(value.get("api_key"), "api_key", max_length=4096)
        base_url = _normalize_base_url(value.get("base_url"))
        entity = _text_field(value.get("entity"), "entity", max_length=256)
        return cls(api_key=api_key, base_url=base_url, entity=entity)

    def to_mapping(self) -> dict[str, Any]:
        """Return the exact frozen credential document, including the secret."""

        return {
            "schema_version": CREDENTIAL_SCHEMA_VERSION,
            "api_key": self.api_key,
            "base_url": self.base_url,
            "entity": self.entity,
        }

    def sanitized(self) -> dict[str, Any]:
        """Return the credential fields safe for operator status output."""

        return {
            "schema_version": CREDENTIAL_SCHEMA_VERSION,
            "base_url": self.base_url,
            "entity": self.entity,
        }


def _text_field(value: Any, name: str, *, max_length: int) -> str:
    if not isinstance(value, str) or not value or len(value) > max_length:
        raise CredentialError(f"W&B credential {name} is invalid")
    if any(character in value for character in "\x00\r\n"):
        raise CredentialError(f"W&B credential {name} is invalid")
    if name == "entity" and any(character.isspace() for character in value):
        raise CredentialError("W&B credential entity is invalid")
    return value


def _normalize_base_url(value: Any) -> str:
    base_url = _text_field(value, "base_url", max_length=2048).rstrip("/")
    try:
        parsed = urlsplit(base_url)
        hostname = parsed.hostname
    except ValueError as exc:
        raise CredentialError("W&B credential base_url must be an HTTP(S) URL") from exc
    if parsed.scheme not in {"http", "https"} or not hostname:
        raise CredentialError("W&B credential base_url must be an HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise CredentialError("W&B credential base_url must not contain userinfo, query, or fragment")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def parse_credentials(value: Mapping[str, Any]) -> WandbCredentials:
    """Parse a mapping using the strict versioned credential contract."""

    return WandbCredentials.from_mapping(value)


def _decode_payload(payload: bytes | str) -> WandbCredentials:
    if isinstance(payload, bytes):
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise CredentialError("W&B credentials are not valid UTF-8") from exc
    else:
        text = payload
    try:
        value = json.loads(text, object_pairs_hook=_strict_object)
    except (TypeError, json.JSONDecodeError) as exc:
        raise CredentialError("W&B credentials are not valid JSON") from exc
    if not isinstance(value, dict):
        raise CredentialError("W&B credentials must be a JSON object")
    return parse_credentials(value)


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Reject duplicate JSON keys instead of silently choosing one."""

    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise CredentialError("W&B credentials contain duplicate fields")
        result[key] = value
    return result


def read_credentials(stream: BinaryIO | TextIO, *, max_bytes: int = MAX_CREDENTIAL_BYTES) -> WandbCredentials:
    """Read one bounded credential JSON document and wait for stream EOF.

    The worker receives credentials through a pipe that the controller closes
    immediately after writing.  Reading in chunks both handles short reads and
    ensures an unbounded pipe cannot be accepted accidentally.
    """

    if max_bytes < 1:
        raise ValueError("max_bytes must be positive")
    chunks: list[bytes | str] = []
    total = 0
    while True:
        chunk = stream.read(min(4096, max_bytes + 1 - total))
        if not chunk:
            break
        chunk_length = len(chunk.encode("utf-8")) if isinstance(chunk, str) else len(chunk)
        total += chunk_length
        if total > max_bytes:
            raise CredentialError("W&B credential payload is too large")
        chunks.append(chunk)
    if not chunks:
        raise CredentialError("W&B credential payload is empty")
    if isinstance(chunks[0], str):
        return _decode_payload("".join(chunks))  # type: ignore[arg-type]
    return _decode_payload(b"".join(chunks))  # type: ignore[arg-type]


def read_credentials_stdin(stream: BinaryIO | TextIO) -> WandbCredentials:
    """Read the fixed worker stdin credential protocol."""

    return read_credentials(stream)


def load_credentials(path: Path) -> WandbCredentials:
    """Load and validate an owner-only credential file without exposing it."""

    try:
        metadata = path.lstat()
    except FileNotFoundError as exc:
        raise CredentialError("W&B credentials are not configured") from exc
    if stat.S_ISLNK(metadata.st_mode):
        raise CredentialError("W&B credential path must not be a symbolic link")
    if stat.S_IMODE(metadata.st_mode) != 0o600:
        raise CredentialError("W&B credential file must have owner-only permissions")
    try:
        payload = path.read_bytes()
    except OSError as exc:
        raise CredentialError("W&B credentials could not be read") from exc
    if len(payload) > MAX_CREDENTIAL_BYTES:
        raise CredentialError("W&B credential payload is too large")
    return _decode_payload(payload)


def save_credentials(path: Path, credentials: WandbCredentials | Mapping[str, Any]) -> None:
    """Atomically persist validated credentials with mode ``0600``."""

    validated = credentials if isinstance(credentials, WandbCredentials) else parse_credentials(credentials)
    encoded = json.dumps(validated.to_mapping(), separators=(",", ":"), sort_keys=True).encode("utf-8")
    if len(encoded) > MAX_CREDENTIAL_BYTES:
        raise CredentialError("W&B credential payload is too large")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary_path: Path | None = None
    descriptor: int | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temporary_path = Path(temporary_name)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(encoded)
            stream.write(b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
        temporary_path = None
        os.chmod(path, 0o600)
        try:
            directory_descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        except OSError:
            directory_descriptor = None
        if directory_descriptor is not None:
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
    except OSError as exc:
        raise CredentialError("W&B credentials could not be stored") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def delete_credentials(path: Path) -> bool:
    """Remove the local credential file, returning whether it existed."""

    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    if stat.S_ISDIR(metadata.st_mode):
        raise CredentialError("W&B credential path is a directory")
    try:
        path.unlink()
    except OSError as exc:
        raise CredentialError("W&B credentials could not be removed") from exc
    return True


def credential_status(path: Path) -> dict[str, Any]:
    """Return sanitized operator status for a credential file."""

    try:
        credentials = load_credentials(path)
    except CredentialError:
        return {"configured": False}
    return {"configured": True, **credentials.sanitized()}
