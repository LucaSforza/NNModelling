"""Tests for the local companion start command and SPA static serving (S4).

The one-command companion serves the built NNModelling editor and launches the
existing training backend on localhost. These tests mock uvicorn and the Valkey
preflight, build a tiny fake ``dist`` directory, and exercise the ASGI app with
in-memory services only — no built frontend and no real Valkey are required.
"""

from __future__ import annotations

import asyncio
import stat
from pathlib import Path
from typing import Any

import httpx
import pytest

from backend.app import create_app
from backend.auth import AuthService, InMemoryAuthStore
from backend.cli import (
    CLIError,
    DistNotFoundError,
    build_parser,
    default_frontend_dist_dir,
    main,
    resolve_dist_dir,
    valkey_reachable,
)
from backend.manager import JobManager
from backend.projects import ProjectManager
from backend.static import SPAStaticFiles, UnsafePathError
from backend.store import InMemoryJobStore

OWNER = "companion-connection"


class NoopExecutor:
    """Executor double that never accepts a job (no runs happen here)."""

    name = "noop"
    kind = "local"

    def can_run(self, resources: dict[str, Any]) -> bool:
        return False

    def describe(self) -> dict[str, Any]:
        return {"id": self.name, "kind": self.kind, "capacity": {}, "enabled": True}

    def submit(self, job, artifact_dir, on_heartbeat, on_finished):
        del job, artifact_dir, on_heartbeat, on_finished
        raise AssertionError("noop executor must never run a job")

    def cancel(self, job_id: str) -> bool:
        del job_id
        return True


def make_fake_dist(root: Path) -> Path:
    """Build a tiny fake Vite ``dist`` directory inside ``root``."""
    dist = root / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>editor</html>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    (dist / "assets" / "style.css").write_text("body {}", encoding="utf-8")
    (root / "secret.txt").write_text("top-secret", encoding="utf-8")
    return dist


def _api_context(tmp_path: Path, dist_dir: Path):
    """Authenticated ASGI app with in-memory services and static serving."""
    auth = AuthService(InMemoryAuthStore())
    pairing = auth.create_pairing("Browser", client_host="127.0.0.1")
    auth.approve(pairing.request_id)
    projects = ProjectManager(tmp_path / "state", sync_enabled=False)
    manager = JobManager(InMemoryJobStore(), tmp_path / "jobs", [NoopExecutor()])
    app = create_app(
        manager,
        auth_service=auth,
        admin_token="admin-secret",
        project_manager=projects,
        static_dir=dist_dir,
    )
    return app, pairing.token


def _authed_headers(token: str) -> dict[str, str]:
    return {"authorization": f"Bearer {token}"}


@pytest.fixture()
def companion(tmp_path: Path):
    """Authenticated ASGI app serving a fake dist directory."""

    class Context:
        def __init__(self) -> None:
            self.dist = make_fake_dist(tmp_path)
            self.app, self.token = _api_context(tmp_path, self.dist)

        def client(self) -> httpx.AsyncClient:
            transport = httpx.ASGITransport(app=self.app)
            return httpx.AsyncClient(transport=transport, base_url="http://test")

    return Context()


# ---------------------------------------------------------------------------
# CLI: argument and default behavior
# ---------------------------------------------------------------------------


def test_cli_help_describes_the_start_command(capsys: pytest.CaptureFixture) -> None:
    with pytest.raises(SystemExit) as excinfo:
        build_parser().parse_args(["--help"])
    assert excinfo.value.code == 0
    out = capsys.readouterr().out
    assert "--host" in out
    assert "--port" in out
    assert "--dist" in out


def test_cli_default_dist_dir_points_at_the_frontend_build() -> None:
    dist = default_frontend_dist_dir()
    assert dist.name == "dist"
    assert dist.parent.name == "front-end"


def test_cli_defaults_start_on_localhost_serving_the_editor(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dist = make_fake_dist(tmp_path)
    calls: dict[str, Any] = {}
    monkeypatch.setattr("backend.cli.uvicorn.run", lambda app, **kwargs: calls.update(app=app, **kwargs))
    monkeypatch.setattr("backend.cli.valkey_reachable", lambda *a, **k: True)

    code = main(["--dist", str(dist)])

    assert code == 0
    assert calls["host"] == "127.0.0.1"
    assert calls["port"] == 8000
    assert calls["reload"] is False
    app = calls["app"]
    assert any(getattr(route, "name", "") == "spa" for route in app.routes)


def test_cli_respects_host_and_port_flags(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dist = make_fake_dist(tmp_path)
    calls: dict[str, Any] = {}
    monkeypatch.setattr("backend.cli.uvicorn.run", lambda app, **kwargs: calls.update(app=app, **kwargs))
    monkeypatch.setattr("backend.cli.valkey_reachable", lambda *a, **k: True)

    code = main(["--dist", str(dist), "--host", "0.0.0.0", "--port", "9000"])

    assert code == 0
    assert calls["host"] == "0.0.0.0"
    assert calls["port"] == 9000


def test_cli_respects_backend_host_and_port_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dist = make_fake_dist(tmp_path)
    monkeypatch.setenv("NNM_BACKEND_HOST", "localhost")
    monkeypatch.setenv("NNM_BACKEND_PORT", "8080")
    calls: dict[str, Any] = {}
    monkeypatch.setattr("backend.cli.uvicorn.run", lambda app, **kwargs: calls.update(app=app, **kwargs))
    monkeypatch.setattr("backend.cli.valkey_reachable", lambda *a, **k: True)

    code = main(["--dist", str(dist)])

    assert code == 0
    assert calls["host"] == "localhost"
    assert calls["port"] == 8080


def test_cli_fails_actionably_when_frontend_assets_are_absent(tmp_path: Path) -> None:
    empty = tmp_path / "no-build"
    empty.mkdir()

    with pytest.raises(DistNotFoundError) as excinfo:
        resolve_dist_dir(str(empty))

    message = str(excinfo.value)
    assert "pnpm --dir front-end build" in message
    assert "index.html" in message


def test_cli_main_exits_nonzero_without_frontend_assets(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    monkeypatch.setattr("backend.cli.default_frontend_dist_dir", lambda: tmp_path / "absent")

    code = main([])

    assert code == 2
    assert "build" in capsys.readouterr().err


def test_cli_fails_actionably_when_valkey_is_unreachable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    dist = make_fake_dist(tmp_path)
    monkeypatch.setattr("backend.cli.valkey_reachable", lambda *a, **k: False)

    code = main(["--dist", str(dist)])

    assert code == 2
    assert "Valkey" in capsys.readouterr().err


def test_cli_provisions_an_administrator_token_before_starting(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    """The local companion must be pairable without a separate admin-init step.

    Reviewer regression (9392bbc): a local server without an administrator
    token cannot approve pairing. The companion provisions the token itself
    before the app is constructed, keeps it private (mode 0600), and never
    prints its value; startup therefore no longer reaches an unpairable state.
    """
    dist = make_fake_dist(tmp_path)
    token_path = tmp_path / "state" / "admin.token"
    monkeypatch.setenv("NNM_ADMIN_TOKEN_FILE", str(token_path))
    monkeypatch.setattr("backend.cli.valkey_reachable", lambda *a, **k: True)
    captured: dict[str, Any] = {}
    monkeypatch.setattr("backend.cli.uvicorn.run", lambda app, **kwargs: captured.update(app=app))

    code = main(["--dist", str(dist)])

    assert code == 0
    assert token_path.is_file()
    assert stat.S_IMODE(token_path.stat().st_mode) == 0o600
    token = token_path.read_text(encoding="utf-8").strip()
    assert len(token) >= 43  # secrets.token_urlsafe(32)
    # The running app must be pairable with the very token just provisioned.
    assert captured["app"].state.admin_token == token
    output = capsys.readouterr().out + capsys.readouterr().err
    assert token not in output


def test_cli_reuses_an_existing_administrator_token(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dist = make_fake_dist(tmp_path)
    token_path = tmp_path / "admin.token"
    token_path.write_text("existing-token-value\n", encoding="utf-8")
    token_path.chmod(0o600)
    monkeypatch.setenv("NNM_ADMIN_TOKEN_FILE", str(token_path))
    monkeypatch.setattr("backend.cli.valkey_reachable", lambda *a, **k: True)
    monkeypatch.setattr("backend.cli.uvicorn.run", lambda *a, **k: None)

    code = main(["--dist", str(dist)])

    assert code == 0
    assert token_path.read_text(encoding="utf-8").strip() == "existing-token-value"


def test_cli_fails_actionably_when_token_initialization_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    """An empty token file is corrupt: fail with an actionable message."""
    dist = make_fake_dist(tmp_path)
    token_path = tmp_path / "empty.token"
    token_path.write_text("", encoding="utf-8")
    monkeypatch.setenv("NNM_ADMIN_TOKEN_FILE", str(token_path))
    monkeypatch.setattr("backend.cli.valkey_reachable", lambda *a, **k: True)
    monkeypatch.setattr("backend.cli.uvicorn.run", lambda *a, **k: None)

    code = main(["--dist", str(dist)])

    assert code == 2
    assert "administrator token" in capsys.readouterr().err


def test_cli_fails_actionably_when_token_path_is_not_writable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    """A token path below a regular file fails with an actionable message."""
    dist = make_fake_dist(tmp_path)
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory", encoding="utf-8")
    monkeypatch.setenv("NNM_ADMIN_TOKEN_FILE", str(blocker / "admin.token"))
    monkeypatch.setattr("backend.cli.valkey_reachable", lambda *a, **k: True)
    monkeypatch.setattr("backend.cli.uvicorn.run", lambda *a, **k: None)

    code = main(["--dist", str(dist)])

    assert code == 2
    assert "administrator token" in capsys.readouterr().err


def test_cli_fails_actionably_when_token_file_is_corrupt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    """A non-UTF8 token file fails with an actionable message."""
    dist = make_fake_dist(tmp_path)
    token_path = tmp_path / "corrupt.token"
    token_path.write_bytes(b"\xff\xfe\x00not-utf8")
    monkeypatch.setenv("NNM_ADMIN_TOKEN_FILE", str(token_path))
    monkeypatch.setattr("backend.cli.valkey_reachable", lambda *a, **k: True)
    monkeypatch.setattr("backend.cli.uvicorn.run", lambda *a, **k: None)

    code = main(["--dist", str(dist)])

    assert code == 2
    assert "administrator token" in capsys.readouterr().err


def test_cli_valkey_reachable_treats_ping_failure_as_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class BrokenClient:
        def ping(self):
            raise ConnectionError("refused")

        def close(self):
            return None

    monkeypatch.setattr("backend.cli.valkey.from_url", lambda *a, **k: BrokenClient())
    assert valkey_reachable() is False


# ---------------------------------------------------------------------------
# Static serving: SPA fallback, assets, content types, traversal
# ---------------------------------------------------------------------------


def test_static_serves_index_html_at_the_root(companion) -> None:
    async def exercise() -> None:
        async with companion.app.router.lifespan_context(companion.app):
            async with companion.client() as client:
                response = await client.get("/")
                assert response.status_code == 200
                assert response.text == "<html>editor</html>"
                assert "text/html" in response.headers["content-type"]

    asyncio.run(exercise())


def test_static_spa_fallback_serves_index_for_unknown_non_api_paths(companion) -> None:
    async def exercise() -> None:
        async with companion.app.router.lifespan_context(companion.app):
            async with companion.client() as client:
                response = await client.get("/editor/some/client/route")
                assert response.status_code == 200
                assert response.text == "<html>editor</html>"

    asyncio.run(exercise())


def test_static_serves_assets_with_content_types(companion) -> None:
    async def exercise() -> None:
        async with companion.app.router.lifespan_context(companion.app):
            async with companion.client() as client:
                js = await client.get("/assets/app.js")
                assert js.status_code == 200
                assert js.text == "console.log(1)"
                assert js.headers["content-type"].startswith("text/javascript")

                css = await client.get("/assets/style.css")
                assert css.status_code == 200
                assert "text/css" in css.headers["content-type"]

    asyncio.run(exercise())


def test_static_rejects_traversal_outside_the_dist_directory(companion) -> None:
    async def exercise() -> None:
        async with companion.app.router.lifespan_context(companion.app):
            async with companion.client() as client:
                # Raw ``/../`` is normalized away by the HTTP client before it
                # reaches the server; the encoded forms below arrive decoded at
                # the handler and must be rejected there (defense in depth for
                # non-normalizing clients and servers).
                encoded = await client.get("/assets/%2e%2e/%2e%2e/secret.txt")
                assert encoded.status_code in {400, 404}
                assert "top-secret" not in encoded.text

                urlencoded = await client.get("/%2e%2e%2fsecret.txt")
                assert urlencoded.status_code in {400, 404}
                assert "top-secret" not in urlencoded.text

    asyncio.run(exercise())


def test_static_resolve_rejects_dotdot_segments(tmp_path: Path) -> None:
    dist = make_fake_dist(tmp_path)
    handler = SPAStaticFiles(dist)

    with pytest.raises(UnsafePathError):
        handler.resolve("/../secret.txt")
    with pytest.raises(UnsafePathError):
        handler.resolve("/assets/%2e%2e/x.js")


def test_static_does_not_shadow_api_404s(companion) -> None:
    async def exercise() -> None:
        async with companion.app.router.lifespan_context(companion.app):
            async with companion.client() as client:
                unknown = await client.get("/api/not/a/route")
                assert unknown.status_code == 404
                assert unknown.text != "<html>editor</html>"
                assert "detail" in unknown.text

    asyncio.run(exercise())


# ---------------------------------------------------------------------------
# API compatibility: /api prefix aliases and root training preservation
# ---------------------------------------------------------------------------


def test_project_api_is_available_under_the_api_prefix(companion, tmp_path: Path) -> None:
    headers = _authed_headers(companion.token)

    async def exercise() -> None:
        async with companion.app.router.lifespan_context(companion.app):
            async with companion.client() as client:
                created = await client.post(
                    "/api/projects",
                    headers=headers,
                    json={"name": "api-proj", "root": str(tmp_path / "proj")},
                )
                assert created.status_code == 201
                project_id = created.json()["id"]

                active = await client.get("/api/projects/active", headers=headers)
                assert active.status_code == 200
                assert active.json()["id"] == project_id

                graph = await client.put(
                    f"/api/projects/{project_id}/graph",
                    headers=headers,
                    json={"nodes": [{"id": "x"}], "edges": []},
                )
                assert graph.status_code == 200

    asyncio.run(exercise())


def test_project_api_prefix_requires_the_same_authentication(companion) -> None:
    async def exercise() -> None:
        async with companion.app.router.lifespan_context(companion.app):
            async with companion.client() as client:
                assert (await client.get("/api/projects")).status_code == 401
                assert (await client.get("/api/projects/active")).status_code == 401

    asyncio.run(exercise())


def test_root_training_and_project_endpoints_survive_the_static_mount(companion) -> None:
    headers = _authed_headers(companion.token)

    async def exercise() -> None:
        async with companion.app.router.lifespan_context(companion.app):
            async with companion.client() as client:
                health = await client.get("/health")
                assert health.status_code == 200
                assert health.json() == {"status": "ok"}

                pairing = await client.post(
                    "/pairing/requests", json={"device_name": "probe"}
                )
                assert pairing.status_code == 201

                projects = await client.get("/projects", headers=headers)
                assert projects.status_code == 200

                datasets = await client.get("/datasets", headers=headers)
                assert datasets.status_code == 200

    asyncio.run(exercise())


def test_app_without_static_dir_keeps_plain_api_behavior(tmp_path: Path) -> None:
    app = create_app(JobManager(InMemoryJobStore(), tmp_path / "jobs", [NoopExecutor()]))
    assert not any(getattr(route, "name", "") == "spa" for route in app.routes)
