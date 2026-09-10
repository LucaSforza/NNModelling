"""Frontend-origin configuration contracts for the backend API."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import httpx

from backend.app import DEFAULT_ALLOWED_ORIGINS, _allowed_origins_from_environment, create_app


def test_default_allowed_origins_include_the_flatpak_renderer() -> None:
    """The packaged renderer has a stable, exact CORS origin."""

    assert "app://nnmodelling" in DEFAULT_ALLOWED_ORIGINS


def test_configured_allowed_origins_preserve_the_desktop_origin(monkeypatch) -> None:
    """Explicit deployment configuration remains authoritative and normalized."""

    monkeypatch.setenv(
        "NNM_ALLOWED_ORIGINS",
        "https://editor.example, app://nnmodelling/",
    )

    assert _allowed_origins_from_environment() == [
        "https://editor.example",
        "app://nnmodelling",
    ]


def test_default_cors_allows_the_flatpak_renderer_origin() -> None:
    """A desktop preflight receives the exact origin without wildcard access."""

    app = create_app(manager=SimpleNamespace(artifact_root=Path("datasets")))

    async def exercise() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://backend") as client:
            return await client.options(
                "/health",
                headers={
                    "Origin": "app://nnmodelling",
                    "Access-Control-Request-Method": "GET",
                },
            )

    response = asyncio.run(exercise())
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "app://nnmodelling"
    assert response.headers.get("access-control-allow-credentials") is None
