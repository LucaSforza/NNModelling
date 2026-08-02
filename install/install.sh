#!/usr/bin/env bash
#
# NNModelling — one-command installer and local launcher.
#
# Fetches the NNModelling repository (or updates an existing checkout), installs
# the pnpm dependencies, builds the editor, ensures a local Valkey is running
# (reusing a healthy instance or starting a repository-local process), and then
# hands control to the companion, which serves the built editor and the training
# backend on localhost at http://127.0.0.1:8000.
#
# Configuration (all optional, via the environment):
#   NNM_DEST_DIR        checkout destination (default: $HOME/.local/share/nnmodelling)
#   NNM_REMOTE_REPO     repository URL to clone/update (default: https://github.com/LucaSforza/NNModelling.git)
#   NNM_BRANCH          branch to check out (default: master)
#   NNM_VALKEY_URL      Valkey URL passed through to the companion (default: valkey://127.0.0.1:6379/0)
#   NNM_VALKEY_PORT     port this script probes/starts (default: 6379; keep in sync with NNM_VALKEY_URL)
#   NNM_BACKEND_HOST / NNM_BACKEND_PORT   companion bind settings (passed through)
#
# Prerequisites are checked, never installed: git, uv, Node.js, pnpm, and
# Valkey 8 (the valkey-server binary) unless an instance is already running.
# The script never prints secrets (in particular, NNM_VALKEY_URL is never
# echoed) and refuses to overwrite a destination it does not own.
set -euo pipefail

log() { printf 'nnm: %s\n' "$*"; }
die() { printf 'nnm: error: %s\n' "$*" >&2; exit 1; }

NNM_REMOTE_REPO="${NNM_REMOTE_REPO:-https://github.com/LucaSforza/NNModelling.git}"
NNM_BRANCH="${NNM_BRANCH:-master}"
NNM_DEST_DIR="${NNM_DEST_DIR:-}"
if [ -z "$NNM_DEST_DIR" ]; then
  # HOME is required only to derive the default destination.
  if [ -z "${HOME:-}" ]; then
    die "HOME is not set; set NNM_DEST_DIR explicitly"
  fi
  NNM_DEST_DIR="$HOME/.local/share/nnmodelling"
fi
NNM_VALKEY_URL="${NNM_VALKEY_URL:-valkey://127.0.0.1:6379/0}"
NNM_VALKEY_PORT="${NNM_VALKEY_PORT:-6379}"

require_tool() { # <name> <hint>
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found on PATH. $2"
}

check_min_major() { # <tool> <version-output> <min-major> <friendly>
  local tool="$1" output="$2" min_major="$3" friendly="$4"
  local raw="$output" major=""
  case "$raw" in
    [vV]*) raw="${raw#?}" ;;
  esac
  major="${raw%%.*}"
  case "$major" in
    ''|*[!0-9]*)
      die "$tool --version reported an unrecognized version ('$output'); $friendly is required"
      ;;
  esac
  if [ "$major" -lt "$min_major" ]; then
    die "$tool --version reported $output; $friendly is required"
  fi
}

require_tool git "Install Git (https://git-scm.com/)."
require_tool uv "Install uv (https://docs.astral.sh/uv/)."
require_tool node "Install Node.js 18 or newer."
require_tool pnpm "Install pnpm 10+ (corepack enable pnpm or npm install --global pnpm)."
# Version minimums are validated before any repository mutation: a clone or
# update must never start with a toolchain that cannot build the editor.
check_min_major node "$(node --version 2>/dev/null || true)" 18 "Node.js 18 or newer"
check_min_major pnpm "$(pnpm --version 2>/dev/null || true)" 10 "pnpm 10 or newer"

dest="$NNM_DEST_DIR"

# --- Destination: clone or update -------------------------------------------

if [ -e "$dest" ] && [ ! -d "$dest" ]; then
  die "destination '$dest' exists and is not a directory; choose another with NNM_DEST_DIR"
fi

is_checkout=0
if [ -d "$dest/.git" ] || { command -v git >/dev/null 2>&1 && git -C "$dest" rev-parse --git-dir >/dev/null 2>&1; }; then
  is_checkout=1
fi

if [ "$is_checkout" = 1 ]; then
  origin="$(git -C "$dest" remote get-url origin 2>/dev/null || true)"
  if [ -z "$origin" ]; then
    die "destination '$dest' is a git checkout without a readable origin; refusing to touch it"
  fi
  if [ "$origin" != "$NNM_REMOTE_REPO" ]; then
    die "destination '$dest' is a git checkout of '$origin', not '$NNM_REMOTE_REPO'; refusing to touch it"
  fi
  log "updating existing checkout at $dest"
  git -C "$dest" checkout --quiet "$NNM_BRANCH" 2>/dev/null \
    || die "cannot check out branch '$NNM_BRANCH' in $dest; check NNM_BRANCH and the repository refs"
  git -C "$dest" pull --ff-only --quiet \
    || die "failed to update $dest; resolve the git error above (local changes may conflict)"
elif [ -d "$dest" ] && [ -n "$(ls -A "$dest")" ]; then
  die "destination '$dest' is not empty and is not an NNModelling checkout; refusing to overwrite it"
else
  log "cloning $NNM_REMOTE_REPO (branch $NNM_BRANCH) into $dest"
  mkdir -p "$(dirname "$dest")"
  if [ -n "$NNM_BRANCH" ]; then
    git clone --depth 1 --branch "$NNM_BRANCH" "$NNM_REMOTE_REPO" "$dest" \
      || die "clone failed; check network access to $NNM_REMOTE_REPO"
  else
    git clone --depth 1 "$NNM_REMOTE_REPO" "$dest" \
      || die "clone failed; check network access to $NNM_REMOTE_REPO"
  fi
fi

# --- Build -------------------------------------------------------------------

log "installing pnpm dependencies"
( cd "$dest" && pnpm install --frozen-lockfile ) \
  || die "pnpm install failed; check network access and the pnpm version"
log "building the editor"
( cd "$dest" && pnpm --dir front-end build ) \
  || die "the frontend build failed; see the build output above"

# --- Valkey: reuse a healthy instance or start a repository-local one --------

valkey_pid=""
started_valkey=0

valkey_reachable() {
  if command -v valkey-cli >/dev/null 2>&1; then
    [ "$(valkey-cli -p "$NNM_VALKEY_PORT" ping 2>/dev/null || true)" = "PONG" ]
  else
    # bash-only TCP probe used when valkey-cli is unavailable.
    ( exec 3<>"/dev/tcp/127.0.0.1/$NNM_VALKEY_PORT" ) 2>/dev/null
  fi
}

if valkey_reachable; then
  log "Valkey already running on port $NNM_VALKEY_PORT (reused)"
else
  require_tool valkey-server "Install Valkey 8, or start one with: just --justfile converted/backend/justfile valkey (or docker-up)"
  log "starting a repository-local Valkey process on port $NNM_VALKEY_PORT"
  mkdir -p "$dest/converted/valkey-data"
  valkey-server "$dest/converted/backend/valkey.conf" \
    --dir "$dest/converted/valkey-data" \
    --port "$NNM_VALKEY_PORT" &
  valkey_pid=$!
  started_valkey=1
  attempt=0
  while [ "$attempt" -lt 20 ]; do
    if valkey_reachable; then
      break
    fi
    attempt=$((attempt + 1))
    sleep 0.25
  done
  if ! valkey_reachable; then
    kill "$valkey_pid" 2>/dev/null || true
    wait "$valkey_pid" 2>/dev/null || true
    die "started Valkey but it did not become reachable on port $NNM_VALKEY_PORT"
  fi
  log "Valkey ready on port $NNM_VALKEY_PORT (started by this script)"
fi

cleanup() {
  if [ "$started_valkey" = 1 ] && [ -n "$valkey_pid" ]; then
    log "stopping the repository-local Valkey process (pid $valkey_pid)"
    kill "$valkey_pid" 2>/dev/null || true
    wait "$valkey_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# --- Companion ----------------------------------------------------------------

log "starting the NNModelling companion (editor + training backend) at http://127.0.0.1:${NNM_BACKEND_PORT:-8000}"
(
  cd "$dest"
  NNM_FRONTEND_DIST="$dest/front-end/dist" \
  PYTHONPATH=converted/src \
  exec uv run --project converted python converted/src/backend/cli.py "$@"
)
