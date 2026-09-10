# Flatpak packaging

`../io.github.LucaSforza.NNModelling.yml` builds the Electron application from
the repository source with the Freedesktop 25.08 runtime and Electron BaseApp.
The build uses pinned pnpm binaries and runs dependency installation offline.

Regenerate the pinned Node and Electron sources from the repository root after
every lockfile change with:

```sh
./flatpak/generate-sources.sh
```

The helper uses a host `flatpak-node-generator` when available and otherwise
uses `org.flatpak.Builder` installed from Flathub. Commit the regenerated file
whenever `pnpm-lock.yaml` changes.

Build and install locally (requires `flatpak-builder` and the Flathub runtime):

```sh
flatpak-builder --force-clean --user --install-deps-from=flathub \
  --repo=repo --install builddir \
  io.github.LucaSforza.NNModelling.yml
flatpak run io.github.LucaSforza.NNModelling
flatpak build-bundle repo NNModelling.flatpak \
  io.github.LucaSforza.NNModelling \
  --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo
```
