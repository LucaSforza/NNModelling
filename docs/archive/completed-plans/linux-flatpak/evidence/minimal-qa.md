# Minimal QA evidence — completed 2026-09-10

Scope follows the user's request for minimal final QA. The installed
create/edit/autosave/close/reopen workflow was not run and remains a manual
pre-release check.

- Frontend type check: passed with 0 errors and 34 existing warnings.
- Focused desktop workspace adapter: 1 file, 2 tests passed.
- Desktop security boundary: 1 file, 2 tests passed.
- Frontend production web build: passed.
- Desktop Electron directory build: passed; packaged ASAR contains only the
  host output, renderer, and package metadata.
- Backend desktop-origin regression: 3 tests passed.
- Desktop entry and AppStream validation: passed.
- Flathub manifest lint: passed with the runtime-update advisory for 26.08;
  the required Electron BaseApp remains on the manifest's 25.08 branch.
- Offline Flatpak build and user installation: passed, commit
  `52715eaa305a5b2df7984ba48451a326395fff4f3679877396fcb7a285eb7fab`.
- Effective permissions: network, IPC, Wayland/fallback-X11, and DRI only;
  no home or host filesystem grant.
- Installed-file smoke check: passed.
- Installed launch smoke: process remained active for the bounded 10-second
  run and was stopped by `timeout`; no application crash was observed.
- Bundle: `NNModelling.flatpak`, 81 MiB,
  SHA-256 `78dd4bb3e2d63f1323ac1fa47b63beaedef9af399537ffab67fed0529336d207`.
- `git diff --check`: passed.

The repository-wide package-only guard still reports the tracked pre-existing
fixture `examples/diagrams/package/models/transformer.spam/model.json` as
lacking exact package identities. This initiative did not modify that fixture.
