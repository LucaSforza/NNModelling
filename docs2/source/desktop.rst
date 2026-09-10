Linux desktop (Flatpak)
=======================

NNModelling is available as one shared Svelte renderer in two hosts: a web
browser and an Electron desktop application. The Linux desktop build is
distributed as a Flatpak with application ID
``io.github.LucaSforza.NNModelling``. It preserves the browser project format
and does not introduce a second graph or type-inference implementation.

The Flatpak contains the editor shell only. FastAPI, Valkey, Podman/Docker,
worker images and training jobs remain in the existing remote backend
deployment. The browser distribution remains available through GitHub Pages
and the Vite development server.

Build from source
-----------------

Install the repository dependencies and build both the shared renderer and
desktop host:

.. code-block:: console

   $ pnpm install --frozen-lockfile
   $ pnpm --dir front-end build
   $ pnpm --dir desktop build

Build and install the local Flatpak with ``flatpak-builder``:

.. code-block:: console

   $ flatpak-builder --force-clean --user --install-deps-from=flathub \
       --repo=repo --install builddir \
       io.github.LucaSforza.NNModelling.yml
   $ flatpak run io.github.LucaSforza.NNModelling

The manifest pins the runtime and build inputs. A release bundle can be
created from the local repository after the build:

.. code-block:: console

   $ flatpak build-bundle repo NNModelling.flatpak \
       io.github.LucaSforza.NNModelling \
       --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo

Backend connection
------------------

The desktop renderer uses the exact origin ``app://nnmodelling``. An operator
must include it in the backend's explicit ``NNM_ALLOWED_ORIGINS`` list, along
with any web origins that should remain supported:

.. code-block:: console

   $ NNM_ALLOWED_ORIGINS=http://127.0.0.1:5174,http://localhost:5174,app://nnmodelling \
       just --justfile converted/backend/justfile backend

Pairing, bearer-token ownership, package uploads and training permissions are
the same as for the web renderer. The Flatpak's network permission only allows
the configured HTTP backend and optional localhost MCP connection; it does not
grant backend authorization. Project selection uses the desktop portal bridge
and does not require blanket home-directory access.
