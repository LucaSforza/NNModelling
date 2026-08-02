"""Static serving of the built NNModelling editor (S4).

The companion serves the production editor from ``front-end/dist`` on the same
origin as the training API. This module implements the safe static handler:

* built assets are served with correct content types,
* any other non-API path falls back to ``index.html`` so client-side routes
  keep working,
* traversal attempts and API-prefixed paths are never rewritten to the SPA,
  so unknown ``/api`` calls surface an API 404 instead of the editor.

The handler is a plain Starlette ASGI callable so it can be mounted with
``app.mount("/", ...)`` after every API route has been registered.
"""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path
from typing import Any

from starlette.responses import FileResponse, JSONResponse

# ``mimetypes`` does not map ``.js`` deterministically on every platform.
# Pin the modern ``text/javascript`` media type so asset responses (and tests)
# are stable regardless of the host operating system.
mimetypes.add_type("text/javascript", ".js")


class UnsafePathError(ValueError):
    """Raised when a request path could escape the dist directory."""


def default_frontend_dist_dir() -> Path:
    """Return the built frontend directory selected by the environment.

    ``NNM_FRONTEND_DIST`` overrides the default repository layout path
    ``<repo root>/front-end/dist``.
    """
    override = os.getenv("NNM_FRONTEND_DIST")
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parents[3] / "front-end" / "dist"


class SPAStaticFiles:
    """Serve a built Vite application with an ``index.html`` fallback.

    Args:
        dist_dir: Directory containing the built ``index.html`` and assets.
    """

    def __init__(self, dist_dir: str | Path) -> None:
        self.dist_dir = Path(dist_dir).resolve()
        self.index_html = self.dist_dir / "index.html"

    # -- URL -> file resolution -------------------------------------------------

    def resolve(self, url_path: str) -> Path | None:
        """Map a request path to a file inside ``dist_dir``.

        Returns the concrete file to serve, ``None`` when the SPA fallback
        (``index.html``) applies, and raises :class:`UnsafePathError` for
        traversal attempts. The caller decides how to translate the fallback
        and error outcomes into responses.

        Args:
            url_path: Decoded ASGI request path (no query string).

        Raises:
            UnsafePathError: When the path could escape the dist directory.
        """
        rel = url_path.lstrip("/")
        if not rel:
            return self.index_html
        self._reject_unsafe(rel)
        candidate = (self.dist_dir / rel).resolve()
        if not candidate.is_relative_to(self.dist_dir):
            raise UnsafePathError(f"path escapes the dist directory: {url_path!r}")
        if candidate.is_file():
            return candidate
        return None

    def _reject_unsafe(self, rel: str) -> None:
        if "\x00" in rel or "\\" in rel:
            raise UnsafePathError(f"unsafe path characters: {rel!r}")
        # ASGI already percent-decodes the path, but the ASGI transport in
        # tests and some servers pass raw encodings; reject them defensively.
        if "%2e" in rel.lower():
            raise UnsafePathError(f"encoded traversal is not allowed: {rel!r}")
        if ".." in rel.split("/"):
            raise UnsafePathError(f"parent traversal is not allowed: {rel!r}")

    # -- ASGI -------------------------------------------------------------------

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            raise AssertionError(f"unexpected scope type: {scope['type']}")
        if scope["method"] not in {"GET", "HEAD"}:
            response = JSONResponse({"detail": "method not allowed"}, status_code=405)
            await response(scope, receive, send)
            return
        path = scope["path"]

        # Never shadow the API: unknown /api paths stay API 404s and are not
        # rewritten to the editor SPA.
        if path == "/api" or path.startswith("/api/"):
            response = JSONResponse({"detail": "not found"}, status_code=404)
            await response(scope, receive, send)
            return

        try:
            file = self.resolve(path)
        except UnsafePathError:
            response = JSONResponse({"detail": "bad request"}, status_code=400)
            await response(scope, receive, send)
            return

        if file is None:
            if self.index_html.is_file():
                response = FileResponse(self.index_html, media_type="text/html")
            else:
                response = JSONResponse({"detail": "not found"}, status_code=404)
            await response(scope, receive, send)
            return

        media_type = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        await FileResponse(file, media_type=media_type)(scope, receive, send)
