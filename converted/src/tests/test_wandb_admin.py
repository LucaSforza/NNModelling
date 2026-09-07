"""Tests for the local W&B administrator credential lifecycle."""

from __future__ import annotations

import base64
import io
import json
import stat
from pathlib import Path

import httpx
import pytest

from backend.wandb_admin import build_parser, connect, disconnect, status, verify_credentials
from backend.wandb_credentials import (
    CredentialError,
    WandbCredentials,
    load_credentials,
    read_credentials_stdin,
)


def _credentials() -> WandbCredentials:
    return WandbCredentials.from_mapping(
        {
            "schema_version": 1,
            "api_key": "test-secret",
            "base_url": "https://wandb.example.test",
            "entity": "team",
        }
    )


def test_connect_verifies_then_stores_owner_only_sanitized_file(tmp_path: Path) -> None:
    path = tmp_path / "wandb-credentials.json"
    seen: list[WandbCredentials] = []

    result = connect(
        path,
        base_url="https://wandb.example.test/",
        entity="team",
        prompt=lambda _prompt: "test-secret",
        verifier=seen.append,
    )

    assert seen == [_credentials()]
    assert result == {
        "configured": True,
        "schema_version": 1,
        "base_url": "https://wandb.example.test",
        "entity": "team",
    }
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert json.loads(path.read_text(encoding="utf-8"))["api_key"] == "test-secret"


def test_verify_credentials_uses_wandb_basic_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class Response:
        status_code = 200

        @staticmethod
        def json() -> dict[str, object]:
            return {"data": {"viewer": {"username": "operator"}}}

    def fake_post(url: str, **kwargs: object) -> Response:
        captured["url"] = url
        captured.update(kwargs)
        return Response()

    monkeypatch.setattr("backend.wandb_admin.httpx.post", fake_post)
    credentials = _credentials()
    verify_credentials(credentials)

    auth = captured["auth"]
    assert isinstance(auth, httpx.BasicAuth)
    request = httpx.Request("POST", "https://wandb.example.test/graphql")
    authenticated = next(auth.auth_flow(request))
    encoded = authenticated.headers["authorization"].removeprefix("Basic ")
    assert base64.b64decode(encoded).decode("utf-8") == f"api:{credentials.api_key}"
    assert "headers" not in captured


def test_verify_credentials_rejects_null_viewer(monkeypatch: pytest.MonkeyPatch) -> None:
    class Response:
        status_code = 200

        @staticmethod
        def json() -> dict[str, object]:
            return {"data": {"viewer": None}}

    monkeypatch.setattr("backend.wandb_admin.httpx.post", lambda *_args, **_kwargs: Response())
    with pytest.raises(CredentialError, match="verification failed"):
        verify_credentials(_credentials())


def test_connect_parser_requires_entity_and_uses_cloud_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NNM_WANDB_BASE_URL", "https://ignored.example.test")
    monkeypatch.setenv("NNM_WANDB_ENTITY", "ignored-team")
    parser = build_parser()

    with pytest.raises(SystemExit):
        parser.parse_args(["connect"])
    args = parser.parse_args(["connect", "--entity", "team"])
    assert args.base_url == "https://api.wandb.ai"
    assert args.entity == "team"


def test_failed_verification_does_not_replace_existing_file(tmp_path: Path) -> None:
    path = tmp_path / "wandb-credentials.json"
    from backend.wandb_credentials import save_credentials

    save_credentials(path, _credentials())
    with pytest.raises(RuntimeError, match="verification"):
        connect(
            path,
            base_url="https://wandb.example.test",
            entity="new-team",
            prompt=lambda _prompt: "new-secret",
            verifier=lambda _credentials: (_ for _ in ()).throw(RuntimeError("verification failed")),
        )
    assert load_credentials(path) == _credentials()


def test_status_and_disconnect_never_include_the_api_key(tmp_path: Path) -> None:
    path = tmp_path / "wandb-credentials.json"
    from backend.wandb_credentials import save_credentials

    save_credentials(path, _credentials())
    assert "test-secret" not in repr(status(path))
    assert disconnect(path) == {"configured": False}
    assert not path.exists()


def test_credential_stdin_protocol_is_strict_and_bounded() -> None:
    payload = json.dumps(_credentials().to_mapping()).encode("utf-8")
    assert read_credentials_stdin(io.BytesIO(payload)) == _credentials()
    with pytest.raises(CredentialError, match="too large"):
        read_credentials_stdin(io.BytesIO(b"x" * (16 * 1024 + 1)))


def test_credential_repr_redacts_secret() -> None:
    assert "test-secret" not in repr(_credentials())
