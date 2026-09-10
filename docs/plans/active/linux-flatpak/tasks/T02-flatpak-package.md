---
id: T02
kind: task
status: ready
plan: ../plan.md
role: operations
depends_on: [T01]
parallel_with: [T03]
write_scope:
  - flatpak/
  - desktop/package.json
---

# Flatpak package

## Objective

Produce a pinned, offline-buildable Flatpak manifest and complete Linux desktop
metadata for the Electron application.

## Context required

- [Initiative plan](../plan.md)
- [Desktop distribution decision](../../../knowledge/decisions/web-and-flatpak-desktop-distribution.md)
- Electron BaseApp and Flatpak Node generator documentation.

## Invariants

- Application ID is `io.github.LucaSforza.NNModelling`.
- Build commands have no network access after declared sources are fetched.
- No blanket home or host filesystem permission is granted.
- Electron runs through Zypak without disabling its sandbox.

## Allowed files

Only `flatpak/` and packaging fields in `desktop/package.json`.

## Out of scope

- Flathub publication and signing.
- Other Linux package formats.
- Backend service packaging.

## Work

1. Add application-ID-named manifest, desktop entry, AppStream metadata, icon,
   and Zypak launcher.
2. Generate pinned pnpm/Electron Flatpak sources.
3. Build the unpacked Electron application inside `flatpak-builder` and install
   exports under `/app`.
4. Validate metadata, permissions, offline behavior, and bundle generation.

## Acceptance criteria

- [ ] Metadata validators pass.
- [ ] `flatpak-builder` builds and installs the manifest.
- [ ] A `.flatpak` bundle is produced from the local repository.
- [ ] No change outside `write_scope`.

## Validation

```bash
desktop-file-validate flatpak/io.github.LucaSforza.NNModelling.desktop
appstreamcli validate --no-net --explain flatpak/io.github.LucaSforza.NNModelling.metainfo.xml
flatpak-builder --force-clean --user --install-deps-from=flathub --repo=flatpak/repo --install flatpak/build flatpak/io.github.LucaSforza.NNModelling.yml
flatpak build-bundle flatpak/repo NNModelling.flatpak io.github.LucaSforza.NNModelling --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo
```

## Required handoff

Return artifacts, manifest permissions, pinned-source regeneration procedure,
exact validation results, and any Flathub-readiness limitation.
