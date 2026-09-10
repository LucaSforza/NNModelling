#!/bin/sh
set -eu

flatpak_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$flatpak_dir/.." && pwd)

generate() {
  "$@" pnpm "$repo_dir/pnpm-lock.yaml" \
    --electron-node-headers \
    --output "$flatpak_dir/generated-sources.json"
}

if command -v flatpak-node-generator >/dev/null 2>&1; then
  generate flatpak-node-generator
elif flatpak info --user org.flatpak.Builder >/dev/null 2>&1; then
  generate flatpak run --filesystem="$repo_dir" --command=flatpak-node-generator org.flatpak.Builder
else
  echo "flatpak-node-generator is required; install org.flatpak.Builder from Flathub" >&2
  exit 1
fi
