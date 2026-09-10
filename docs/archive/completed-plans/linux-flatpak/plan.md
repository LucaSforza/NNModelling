---
id: linux-flatpak
kind: plan
status: done
updated: 2026-09-10
areas:
  - frontend
  - desktop
  - distribution
  - testing
---

# Linux Flatpak desktop distribution

## Goal

Ship NNModelling as an installable Linux Flatpak that can create, open, edit,
automatically save, and reopen project directories while preserving the
existing web application and sharing its renderer, `DiagramCore`, package
runtime, type inference, and remote-training behavior.

## Current behavior

The Svelte/Vite application owns live diagram state in the browser and opens
writable projects through the browser File System Access API. The root pnpm
workspace has no desktop host, Flatpak manifest, Linux desktop metadata, or
installed-application verification path. See the accepted
[desktop distribution decision](../../../knowledge/decisions/web-and-flatpak-desktop-distribution.md).

## Scope

- Add a minimal Electron main/preload host for the existing frontend build.
- Select the browser or desktop project adapter at the host boundary without
  duplicating project or graph semantics.
- Build an offline-capable Flatpak from pinned sources with an application
  launcher, icon, desktop entry, and AppStream metadata.
- Retain web development, web production builds, browser project access,
  browser-backed MCP, and remote backend connections.
- Perform minimal installed-artifact QA: build, install, inspect permissions,
  and perform a bounded launch smoke. The exhaustive create/edit/save/reopen
  workflow is an explicit manual pre-release follow-up owned by the user.

## Non-goals

- Embedding FastAPI, Valkey, Podman/Docker, workers, datasets, or training jobs.
- Windows or macOS installers, application stores, signing, or auto-update.
- A second desktop graph implementation or desktop-only model format.
- Broad home-directory or host-filesystem Flatpak access.
- Publishing to Flathub; the repository will produce a submission-ready local
  manifest and bundle, while publication remains a release operation.

## Decisions and invariants

- The accepted
  [shared web and Flatpak desktop decision](../../../knowledge/decisions/web-and-flatpak-desktop-distribution.md)
  is normative.
- `DiagramCore` remains the only live graph authority.
- Web and desktop builds use the same frontend source and tests.
- Platform APIs terminate behind typed adapters; renderer Node integration is
  disabled and the preload API is capability-specific.
- Project-relative paths retain existing validation, transactional creation,
  ordered saves, and visible-error semantics.
- No absolute path, Electron capability identifier, or secret enters portable
  project or backend data.
- The [Electron desktop host contract](../../../knowledge/contracts/desktop-host.md)
  defines process ownership, bridge operations, origin and sandbox rules.

## Contracts and control flow

```text
web deployment ───────> shared Svelte renderer ───────> DiagramCore
       │                         │                           │
File System Access API     project workspace port      package/Lua runtime
                                 │
Electron renderer ── typed preload bridge ── Electron main ── portal-visible files

shared renderer ── optional WebSocket ── thin MCP proxy
shared renderer ── authenticated HTTP ── remote training backend
```

## Task graph

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [`T01`](tasks/T01-electron-host-and-project-adapter.md) | `frontend` | — | — | `desktop/`, `front-end/src/project-workspace/`, `front-end/src/App.svelte`, workspace manifests | Shared renderer runs securely in Electron and preserves the web adapter |
| [`T02`](tasks/T02-flatpak-package.md) | `operations` | `T01` | `T03` | `flatpak/`, desktop package metadata | Flatpak manifest builds and exports a launchable Linux application |
| [`T03`](tasks/T03-desktop-tests-and-documentation.md) | `testing` | `T01` | `T02` | desktop/frontend tests, `docs2/`, current KB testing/operations | Host boundary and user workflow are documented and covered |
| [`T04`](tasks/T04-installed-flatpak-qa.md) | `integration` | `T02`, `T03` | — | plan status and retained evidence only | Built Flatpak is installed and passes a minimal launch/permission smoke test |

Parallel tasks have non-overlapping implementation scopes. Shared manifest or
lockfile changes are integrated serially by the initiative owner.

## Integration and review gates

- Electron security review finds no renderer Node integration, raw IPC export,
  navigation escape, shell execution, or arbitrary filesystem primitive.
- Frontend `check`, focused adapter tests, and production web build pass; the
  package-only guard's unrelated tracked-fixture baseline is recorded.
- Desktop unit tests and packaged Electron smoke check pass.
- Flatpak metadata validation and `flatpak-builder` complete without network
  access during build commands.
- The installed app remains active through the bounded launch smoke without
  `--no-sandbox` and without blanket host filesystem permissions.
- Focused adapter tests preserve web and desktop create/open/save selection.

## Acceptance criteria

- [x] `pnpm --dir front-end build` still produces the deployable web app.
- [x] Electron loads the same frontend and the focused adapter tests cover the
      shared create/open/read/write contract; exhaustive installed lifecycle
      QA remains the user's manual pre-release step.
- [x] The Electron renderer is sandboxed, context-isolated, and has no Node
      integration.
- [x] Flatpak build inputs are pinned and its build commands run offline.
- [x] The repository produces an installable `.flatpak` bundle with application
      ID `io.github.LucaSforza.NNModelling`.
- [x] The installed Flatpak launches on Linux; exhaustive
      project-lifecycle QA remains documented as a manual pre-release check.
- [x] Remote backend access and optional localhost MCP access remain possible
      through the declared network permission.
- [x] Current architecture, project-workspace, testing, and operations KB text
      describes both supported hosts without weakening portable-data rules.

## Final verification

Run from the repository root:

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end guard:package-only
pnpm --dir front-end build
pnpm --dir desktop test
pnpm --dir desktop build
desktop-file-validate flatpak/io.github.LucaSforza.NNModelling.desktop
appstreamcli validate --no-net --explain flatpak/io.github.LucaSforza.NNModelling.metainfo.xml
flatpak-builder --force-clean --user --install-deps-from=flathub --repo=repo --install builddir io.github.LucaSforza.NNModelling.yml
flatpak run io.github.LucaSforza.NNModelling
flatpak build-bundle repo NNModelling.flatpak io.github.LucaSforza.NNModelling --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo
```

## Knowledge and archive impact

- Add the accepted desktop-distribution decision and index it.
- Update system architecture and browser-MCP wording from browser-only to the
  active frontend renderer where applicable.
- Amend writable-project workspace consequences for browser and desktop hosts.
- Add the desktop host contract and amend pairing for its exact application
  origin.
- Add Flatpak lifecycle and installed-app QA to operations and testing.
- When every gate passes, mark all tasks and this initiative done, retain only
  useful build evidence, and archive the initiative intact.
