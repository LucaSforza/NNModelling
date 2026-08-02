"""uv-managed project environment bootstrap and state inspection.

A project owns a reproducible ``uv`` environment at ``<root>/.venv``. The
companion drives synchronization with ``uv sync --project <root>`` so users
never invoke ``uv`` manually. Failures — a missing ``uv`` executable, a sync
timeout, or a non-zero exit — are surfaced as structured
:class:`EnvironmentSyncError` failures and are never masked by falling back to
the companion interpreter.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from backend.project_schema import EnvironmentState
from backend.store import utc_now

SYNC_TIMEOUT_SECONDS = 600
MAX_SYNC_MESSAGE = 4000


class EnvironmentSyncError(Exception):
    """Raised when a project environment cannot be synchronized.

    Attributes:
        code: Stable machine-readable error identifier (``uv_missing``,
            ``sync_timeout``, or ``sync_failed``).
    """

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def find_uv() -> str | None:
    """Locate the uv executable, honoring the ``NNM_UV_BIN`` override."""
    override = os.getenv("NNM_UV_BIN")
    if override:
        return override
    return shutil.which("uv")


def project_python(root: str | Path) -> Path:
    """Return the project venv interpreter path, platform aware."""
    root_path = Path(root)
    if os.name == "nt":
        return root_path / ".venv" / "Scripts" / "python.exe"
    return root_path / ".venv" / "bin" / "python"


def check_project_environment(root: str | Path) -> EnvironmentState:
    """Return the current environment state without invoking uv."""
    python = project_python(root)
    if python.is_file():
        return EnvironmentState(status="ready", python=str(python))
    return EnvironmentState(status="missing", python=str(python))


def sync_project_environment(
    root: str | Path,
    *,
    uv_bin: str | None = None,
    timeout: float = SYNC_TIMEOUT_SECONDS,
    env: dict[str, str] | None = None,
) -> EnvironmentState:
    """Run ``uv sync --project <root>`` and report the resulting state.

    The interpreter path is always the project's own ``.venv`` interpreter;
    a failed sync never causes a silent fallback to another interpreter.

    Args:
        root: Project root containing ``pyproject.toml``.
        uv_bin: Explicit uv executable (defaults to ``find_uv()``).
        timeout: Maximum seconds the sync subprocess may run.
        env: Optional environment override for the subprocess (tests).

    Returns:
        The observed environment state after the sync attempt.

    Raises:
        EnvironmentSyncError: uv is unavailable, the sync timed out, or the
            sync command exited non-zero. The message is client-visible and
            never contains secret material.
    """

    root_path = Path(root)
    uv = uv_bin or find_uv()
    if uv is None:
        raise EnvironmentSyncError(
            "uv_missing",
            "uv is not installed; install uv (https://docs.astral.sh/uv) so the "
            "companion can create the project environment",
        )
    try:
        completed = subprocess.run(
            [uv, "sync", "--project", str(root_path)],
            cwd=str(root_path),
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
    except FileNotFoundError as exc:
        raise EnvironmentSyncError(
            "uv_missing",
            f"uv executable {uv!r} was not found; install uv so the companion can "
            "create the project environment",
        ) from None
    except subprocess.TimeoutExpired as exc:
        raise EnvironmentSyncError(
            "sync_timeout",
            f"uv sync exceeded {timeout:.0f} seconds and was cancelled",
        ) from exc
    python = project_python(root_path)
    if completed.returncode != 0:
        detail = _tail(completed.stderr or completed.stdout)
        raise EnvironmentSyncError("sync_failed", f"uv sync failed: {detail}")
    if not python.is_file():
        raise EnvironmentSyncError(
            "sync_failed",
            "uv sync completed but the project interpreter was not created",
        )
    return EnvironmentState(
        status="ready",
        python=str(python),
        synced_at=utc_now(),
    )


def _tail(text: str, *, limit: int = MAX_SYNC_MESSAGE) -> str:
    """Truncate subprocess output to a bounded client-visible message."""
    stripped = text.strip()
    if len(stripped) <= limit:
        return stripped or "no output"
    return stripped[-limit:]
