"""One-command local companion for NNModelling (S4).

Running this module starts the existing FastAPI training backend on localhost
and serves the built NNModelling editor from the same origin, so the editor's
project APIs resolve at ``/api`` and the Training Sidebar can pair with the
same process at its default ``http://127.0.0.1:8000`` URL. The companion never
proxies or routes remote jobs; the sidebar may equally connect to an
independently managed remote backend.

The command fails actionably when the frontend assets are absent or Valkey is
unreachable instead of silently serving an empty UI.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Allow direct script execution from the repository root
# (``uv run python converted/src/backend/cli.py``), where ``src`` is not on the
# import path: insert the package root before importing backend internals.
# ``python -m backend.cli`` requires ``backend`` to be importable already, which
# is the case inside the repository environment (``PYTHONPATH=src`` or pytest).
if __name__ == "__main__":  # pragma: no cover - exercised by direct runs
    _package_root = Path(__file__).resolve().parents[1]
    if str(_package_root) not in sys.path:
        sys.path.insert(0, str(_package_root))

import uvicorn  # noqa: E402
import valkey  # noqa: E402

from backend import app as backend_app  # noqa: E402
from backend.admin_cli import (  # noqa: E402
    configured_admin_token_path,
    initialize_admin_token,
)
from backend.static import SPAStaticFiles, default_frontend_dist_dir  # noqa: E402

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
DEFAULT_VALKEY_URL = "valkey://127.0.0.1:6379/0"


class CLIError(Exception):
    """Actionable companion startup failure (mapped to exit code 2)."""


class DistNotFoundError(CLIError):
    """The built frontend directory does not contain an ``index.html``."""


def build_parser() -> argparse.ArgumentParser:
    """Build the companion command line parser."""
    parser = argparse.ArgumentParser(
        prog="python -m backend.cli",
        description=(
            "Serve the built NNModelling editor and start the local training "
            "backend on localhost. The Training Sidebar can pair with this "
            "process or with an independently managed remote backend."
        ),
    )
    parser.add_argument(
        "--host",
        default=os.getenv("NNM_BACKEND_HOST", DEFAULT_HOST),
        help=f"interface to bind (default: %(default)s)",
    )
    parser.add_argument(
        "--port",
        type=_env_port,
        default=os.getenv("NNM_BACKEND_PORT", str(DEFAULT_PORT)),
        help=f"port to listen on (default: %(default)s)",
    )
    parser.add_argument(
        "--dist",
        default=None,
        help=(
            "built frontend directory (default: NNM_FRONTEND_DIST or "
            "<repo>/front-end/dist)"
        ),
    )
    parser.add_argument(
        "--valkey-url",
        default=os.getenv("NNM_VALKEY_URL", DEFAULT_VALKEY_URL),
        help=f"Valkey URL for the auth/job stores (default: %(default)s)",
    )
    return parser


def resolve_dist_dir(value: str | None) -> Path:
    """Resolve the built frontend directory and fail actionably when absent.

    Args:
        value: ``--dist`` value, or ``None`` for the environment default.

    Returns:
        The resolved dist directory.

    Raises:
        DistNotFoundError: When no ``index.html`` exists at the location.
    """
    dist = Path(value).expanduser().resolve() if value else default_frontend_dist_dir()
    index = dist / "index.html"
    if not index.is_file():
        raise DistNotFoundError(
            f"frontend assets are not built: expected {index}. "
            "Build the editor first with `pnpm --dir front-end build`, or run "
            "the Vite development server with `pnpm --dir front-end dev` "
            "(which proxies /api to this backend)."
        )
    return dist


def valkey_reachable(url: str | None = None, *, timeout: float = 2.0) -> bool:
    """Return whether the configured Valkey store answers a ping."""
    client = valkey.from_url(
        url or os.getenv("NNM_VALKEY_URL", DEFAULT_VALKEY_URL),
        socket_connect_timeout=timeout,
        socket_timeout=timeout,
    )
    try:
        client.ping()
        return True
    except Exception:  # noqa: BLE001 - any store failure means unreachable
        return False
    finally:
        try:
            client.close()
        except Exception:  # noqa: BLE001 - teardown must never mask the result
            pass


def _ensure_admin_token() -> None:
    """Provision or reuse the local administrator capability before startup.

    The companion must be pairable immediately after it starts: the
    administrator token is created (or reused and tightened to mode ``0600``)
    at the path selected by ``NNM_ADMIN_TOKEN_FILE``, so the running app's own
    token reader finds it. The token value is never printed — only its path.

    Raises:
        CLIError: When the token cannot be created or read because of a
            permission, empty, or corrupt token-file error.
    """
    token_path = configured_admin_token_path()
    try:
        initialize_admin_token(token_path)
    except (OSError, RuntimeError, UnicodeError) as exc:
        raise CLIError(
            f"cannot provision the administrator token at {token_path}: {exc}. "
            "Fix the path permissions or remove the empty/corrupt token file "
            "and retry."
        ) from exc
    print(f"Administrator token ready at {token_path}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    """Run the companion: serve the editor and start the local backend.

    Returns:
        0 when the server ran (or is about to run), 2 for actionable startup
        failures.
    """
    args = build_parser().parse_args(argv)
    try:
        dist_dir = resolve_dist_dir(args.dist)
        if not valkey_reachable(args.valkey_url):
            raise CLIError(
                "Valkey is not reachable at "
                f"{args.valkey_url}. Start it first with "
                "`just --justfile converted/backend/justfile valkey` or "
                "`just --justfile converted/backend/justfile docker-up`."
            )
        _ensure_admin_token()
    except CLIError as exc:
        print(f"nnm: error: {exc}", file=sys.stderr)
        return 2

    app = backend_app.create_app(static_dir=dist_dir)
    print(f"Serving NNModelling editor and training backend at http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, reload=False)
    return 0


def _env_port(value: str) -> int:
    try:
        return int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid port: {value!r}") from exc


if __name__ == "__main__":
    raise SystemExit(main())
