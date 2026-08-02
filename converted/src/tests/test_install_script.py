"""Tests for the one-command NNModelling installer script (S4-INSTALLER).

``install/install.sh`` fetches the repository (or updates an existing
checkout), installs pnpm dependencies, builds the editor, ensures a local
Valkey is running (reusing a healthy instance or starting a repository-local
process), and then execs the companion CLI. These tests execute the real
script against fake ``PATH`` command shims and temporary directories: they
never touch the network, never start a real Valkey, and never write outside
the test directory.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
INSTALL_SCRIPT = REPO_ROOT / "install" / "install.sh"

DEFAULT_REMOTE = "https://github.com/LucaSforza/NNModelling.git"

# ---------------------------------------------------------------------------
# Fake PATH shims
# ---------------------------------------------------------------------------

FAKE_GIT = """\
#!/usr/bin/env bash
{ echo "git $* (cwd=$PWD)"; } >> "$FAKE_LOG" 2>/dev/null || true
if [ "$1" = "clone" ]; then
  dest="${!#}"
  mkdir -p "$dest/.git"
  exit 0
fi
if [ "$1" = "-C" ]; then
  dir="$2"
  case "$3" in
    rev-parse)
      if [ -d "$dir/.git" ]; then echo ".git"; exit 0; fi
      exit 1
      ;;
    remote)
      if [ "${FAKE_GIT_ORIGIN_SET:-0}" = "1" ]; then echo "${FAKE_GIT_ORIGIN:-}"; else echo "$DEFAULT_REMOTE"; fi
      exit 0
      ;;
    checkout)
      [ "${FAKE_GIT_CHECKOUT_FAIL:-0}" = "1" ] && exit 1
      exit 0
      ;;
    *) exit 0 ;;
  esac
fi
exit 0
"""

FAKE_UV = """\
#!/usr/bin/env bash
{
  echo "uv $* (cwd=$PWD)"
  env | grep -E '^(PYTHONPATH|NNM_FRONTEND_DIST|NNM_VALKEY_URL|NNM_BACKEND_HOST|NNM_BACKEND_PORT|NNM_ADMIN_TOKEN_FILE)=' || true
} >> "$FAKE_LOG" 2>/dev/null || true
exit 0
"""

FAKE_PNPM = """\
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then printf '%s\\n' "${FAKE_PNPM_VERSION:-10.0.0}"; exit 0; fi
{ echo "pnpm $* (cwd=$PWD)"; } >> "$FAKE_LOG" 2>/dev/null || true
exit 0
"""

FAKE_NODE = """\
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then printf '%s\\n' "${FAKE_NODE_VERSION:-v20.0.0}"; exit 0; fi
exit 0
"""

# In "start" mode valkey-cli answers PONG only after the fake valkey-server
# wrote the readiness marker; in the default "healthy" mode it always answers.
FAKE_VALKEY_CLI = """\
#!/usr/bin/env bash
if [ "${FAKE_VALKEY_MODE:-healthy}" = "start" ]; then
  if [ -f "$FAKE_VALKEY_READY_MARKER" ]; then echo "PONG"; else exit 1; fi
else
  echo "PONG"
fi
"""

FAKE_VALKEY_SERVER = """\
#!/usr/bin/env bash
{ echo "valkey-server $* (cwd=$PWD)"; } >> "$FAKE_LOG" 2>/dev/null || true
echo "$$" > "$FAKE_VALKEY_PIDFILE"
touch "$FAKE_VALKEY_READY_MARKER"
trap 'exit 0' TERM INT
while :; do sleep 1; done
"""


def _bash() -> str:
    return shutil.which("bash") or "bash"


def _make_fake_bin(tmp_path: Path) -> Path:
    """Write all fake command shims into ``<tmp>/bin`` and return the dir."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    scripts = {
        "git": FAKE_GIT,
        "uv": FAKE_UV,
        "pnpm": FAKE_PNPM,
        "node": FAKE_NODE,
        "valkey-cli": FAKE_VALKEY_CLI,
        "valkey-server": FAKE_VALKEY_SERVER,
    }
    for name, body in scripts.items():
        path = bin_dir / name
        path.write_text(body, encoding="utf-8")
        path.chmod(0o755)
    return bin_dir


def run_installer(
    tmp_path: Path,
    *,
    valkey_mode: str = "healthy",
    extra_env: dict[str, str] | None = None,
    args: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run the real installer with fake PATH shims and isolated env."""
    bin_dir = _make_fake_bin(tmp_path)
    log_path = tmp_path / "calls.log"
    dest = tmp_path / "dest"
    env = {
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "HOME": str(tmp_path),
        "NNM_DEST_DIR": str(dest),
        "NNM_REMOTE_REPO": DEFAULT_REMOTE,
        "DEFAULT_REMOTE": DEFAULT_REMOTE,
        "FAKE_LOG": str(log_path),
        "FAKE_VALKEY_MODE": valkey_mode,
        "FAKE_VALKEY_READY_MARKER": str(tmp_path / "valkey-ready"),
        "FAKE_VALKEY_PIDFILE": str(tmp_path / "valkey.pid"),
    }
    env.update(extra_env or {})
    return subprocess.run(
        [_bash(), str(INSTALL_SCRIPT), *(args or [])],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


def _calls(tmp_path: Path) -> str:
    log = tmp_path / "calls.log"
    return log.read_text(encoding="utf-8") if log.exists() else ""


@pytest.fixture()
def fake_bin(tmp_path: Path) -> Path:
    return _make_fake_bin(tmp_path)


# ---------------------------------------------------------------------------
# Syntax and prerequisites
# ---------------------------------------------------------------------------


def test_installer_script_passes_bash_syntax_check() -> None:
    result = subprocess.run([_bash(), "-n", str(INSTALL_SCRIPT)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_installer_fails_actionably_when_a_prerequisite_is_missing(tmp_path: Path) -> None:
    empty_bin = tmp_path / "empty-bin"
    empty_bin.mkdir()
    env = {
        "PATH": str(empty_bin),
        "HOME": str(tmp_path),
        "NNM_DEST_DIR": str(tmp_path / "dest"),
    }
    result = subprocess.run(
        [_bash(), str(INSTALL_SCRIPT)], env=env, capture_output=True, text=True
    )
    assert result.returncode != 0
    assert "git is required" in result.stderr


def test_installer_honors_explicit_destination_without_home(tmp_path: Path) -> None:
    """NNM_DEST_DIR is documented as the fallback when HOME is unavailable."""
    bin_dir = _make_fake_bin(tmp_path)
    dest = tmp_path / "explicit-destination"
    env = {
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "NNM_DEST_DIR": str(dest),
        "NNM_REMOTE_REPO": DEFAULT_REMOTE,
        "DEFAULT_REMOTE": DEFAULT_REMOTE,
        "FAKE_LOG": str(tmp_path / "calls.log"),
        "FAKE_VALKEY_MODE": "healthy",
        "FAKE_VALKEY_READY_MARKER": str(tmp_path / "valkey-ready"),
        "FAKE_VALKEY_PIDFILE": str(tmp_path / "valkey.pid"),
    }

    result = subprocess.run(
        [_bash(), str(INSTALL_SCRIPT)], env=env, capture_output=True, text=True, timeout=60
    )

    assert result.returncode == 0, result.stderr
    assert dest.is_dir()


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"FAKE_NODE_VERSION": "v16.20.0"}, "Node.js 18"),
        ({"FAKE_PNPM_VERSION": "8.15.0"}, "pnpm 10"),
    ],
)
def test_installer_rejects_unsupported_node_and_pnpm_versions(
    tmp_path: Path,
    overrides: dict[str, str],
    expected: str,
) -> None:
    """Published Node 18+/pnpm 10+ prerequisites must be enforced."""
    result = run_installer(
        tmp_path,
        extra_env=overrides,
    )

    assert result.returncode != 0
    assert expected in result.stderr
    assert "clone" not in _calls(tmp_path)


@pytest.mark.parametrize(
    "overrides",
    [
        {"FAKE_NODE_VERSION": "garbage-output"},
        {"FAKE_PNPM_VERSION": "definitely-not-semver"},
    ],
)
def test_installer_rejects_malformed_node_and_pnpm_version_output(
    tmp_path: Path,
    overrides: dict[str, str],
) -> None:
    """Unparseable version output must fail clearly, before any repository mutation."""
    result = run_installer(
        tmp_path,
        extra_env=overrides,
    )

    assert result.returncode != 0
    assert "--version" in result.stderr
    assert "clone" not in _calls(tmp_path)


def test_installer_accepts_v_prefixed_and_plain_major_versions(tmp_path: Path) -> None:
    """Normal v18.x / 10.x version forms are accepted."""
    result = run_installer(
        tmp_path,
        extra_env={"FAKE_NODE_VERSION": "v18.19.1", "FAKE_PNPM_VERSION": "10.1.0"},
    )
    assert result.returncode == 0, result.stderr
    assert "clone --depth 1" in _calls(tmp_path)


# ---------------------------------------------------------------------------
# Destination: clone vs update vs refusal
# ---------------------------------------------------------------------------


def test_installer_clones_into_a_missing_destination(tmp_path: Path) -> None:
    result = run_installer(tmp_path)
    assert result.returncode == 0, result.stderr
    calls = _calls(tmp_path)
    assert f"clone --depth 1 --branch master {DEFAULT_REMOTE} {tmp_path / 'dest'}" in calls


def test_installer_clones_the_configured_branch_and_remote(tmp_path: Path) -> None:
    result = run_installer(
        tmp_path,
        extra_env={
            "NNM_BRANCH": "dev",
            "NNM_REMOTE_REPO": "https://example.invalid/fork.git",
        },
    )
    assert result.returncode == 0, result.stderr
    calls = _calls(tmp_path)
    assert "clone --depth 1 --branch dev https://example.invalid/fork.git" in calls


def test_installer_updates_an_existing_checkout_without_cloning(tmp_path: Path) -> None:
    dest = tmp_path / "dest"
    dest.mkdir()
    (dest / ".git").mkdir()
    result = run_installer(tmp_path)
    assert result.returncode == 0, result.stderr
    calls = _calls(tmp_path)
    assert "pull --ff-only" in calls
    assert "clone" not in calls


def test_installer_refuses_an_unrelated_nonempty_destination(tmp_path: Path) -> None:
    dest = tmp_path / "dest"
    dest.mkdir()
    marker = dest / "important.txt"
    marker.write_text("keep me", encoding="utf-8")
    result = run_installer(tmp_path)
    assert result.returncode != 0
    assert "refusing" in result.stderr
    assert marker.read_text(encoding="utf-8") == "keep me"


def test_installer_refuses_an_existing_checkout_of_a_different_remote(
    tmp_path: Path,
) -> None:
    dest = tmp_path / "dest"
    dest.mkdir()
    (dest / ".git").mkdir()
    result = run_installer(
        tmp_path,
        extra_env={
            "FAKE_GIT_ORIGIN_SET": "1",
            "FAKE_GIT_ORIGIN": "https://other.invalid/other.git",
        },
    )
    assert result.returncode != 0
    assert "refusing" in result.stderr


def test_installer_refuses_a_checkout_without_an_origin(tmp_path: Path) -> None:
    """An origin-less checkout cannot be established as the trusted repository."""
    dest = tmp_path / "dest"
    dest.mkdir()
    (dest / ".git").mkdir()

    result = run_installer(tmp_path, extra_env={"FAKE_GIT_ORIGIN_SET": "1", "FAKE_GIT_ORIGIN": ""})

    assert result.returncode != 0
    assert "origin" in result.stderr
    assert "pull --ff-only" not in _calls(tmp_path)


def test_installer_stops_when_the_requested_branch_cannot_be_checked_out(tmp_path: Path) -> None:
    """A failed NNM_BRANCH checkout must not silently update another branch."""
    dest = tmp_path / "dest"
    dest.mkdir()
    (dest / ".git").mkdir()

    result = run_installer(
        tmp_path,
        extra_env={"NNM_BRANCH": "missing-branch", "FAKE_GIT_CHECKOUT_FAIL": "1"},
    )

    assert result.returncode != 0
    assert "branch" in result.stderr
    assert "pull --ff-only" not in _calls(tmp_path)


def test_install_page_does_not_scope_destination_override_only_to_curl() -> None:
    """Pipeline examples must pass NNM_DEST_DIR to bash, not just to curl."""
    page = REPO_ROOT / "install" / "index.html"

    assert "NNM_DEST_DIR=~/nnmodelling curl -fsSL" not in page.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


def test_installer_builds_the_editor_after_cloning(tmp_path: Path) -> None:
    result = run_installer(tmp_path)
    assert result.returncode == 0, result.stderr
    calls = _calls(tmp_path)
    dest = tmp_path / "dest"
    assert f"pnpm install --frozen-lockfile (cwd={dest})" in calls
    assert f"pnpm --dir front-end build (cwd={dest})" in calls


# ---------------------------------------------------------------------------
# Valkey: reuse a healthy instance
# ---------------------------------------------------------------------------


def test_installer_reuses_a_healthy_valkey_instance(tmp_path: Path) -> None:
    result = run_installer(tmp_path, valkey_mode="healthy")
    assert result.returncode == 0, result.stderr
    assert "reused" in result.stdout
    assert "valkey-server" not in _calls(tmp_path)


# ---------------------------------------------------------------------------
# Valkey: start a repository-local process and clean it up
# ---------------------------------------------------------------------------


def test_installer_starts_a_repository_local_valkey_when_none_is_healthy(
    tmp_path: Path,
) -> None:
    result = run_installer(tmp_path, valkey_mode="start")
    assert result.returncode == 0, result.stderr
    calls = _calls(tmp_path)
    dest = tmp_path / "dest"
    assert "valkey-server" in calls
    assert "valkey.conf" in calls
    assert f"--dir {dest}/converted/valkey-data" in calls
    pidfile = tmp_path / "valkey.pid"
    assert pidfile.is_file()


def test_installer_cleans_up_only_the_valkey_it_started(tmp_path: Path) -> None:
    result = run_installer(tmp_path, valkey_mode="start")
    assert result.returncode == 0, result.stderr
    pid = int((tmp_path / "valkey.pid").read_text(encoding="utf-8").strip())
    probe = subprocess.run(["kill", "-0", str(pid)], capture_output=True)
    assert probe.returncode != 0, "started Valkey process must be stopped on exit"


def test_installer_reuses_an_existing_valkey_without_starting_or_killing(
    tmp_path: Path,
) -> None:
    result = run_installer(tmp_path, valkey_mode="healthy")
    assert result.returncode == 0, result.stderr
    pidfile = tmp_path / "valkey.pid"
    assert not pidfile.exists()


# ---------------------------------------------------------------------------
# Companion exec command and environment
# ---------------------------------------------------------------------------


def test_installer_execs_the_companion_cli_with_the_expected_environment(
    tmp_path: Path,
) -> None:
    result = run_installer(
        tmp_path,
        extra_env={"NNM_VALKEY_URL": "valkey://example.invalid:6379/5"},
    )
    assert result.returncode == 0, result.stderr
    calls = _calls(tmp_path)
    dest = tmp_path / "dest"
    assert "uv run --project converted python converted/src/backend/cli.py" in calls
    assert "PYTHONPATH=converted/src" in calls
    assert f"NNM_FRONTEND_DIST={dest}/front-end/dist" in calls
    assert "NNM_VALKEY_URL=valkey://example.invalid:6379/5" in calls
