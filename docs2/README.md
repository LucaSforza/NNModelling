# Public documentation

`docs2/` contains the English user, operator and integration guides. Sphinx
builds the site from reStructuredText; TypeDoc generates the frontend reference
from the TypeScript public entry points. Internal agent contracts live in
`docs/`, not here.

## Build and preview

From the repository root, with Node/pnpm, Python and `uv` installed:

```bash
pnpm install --frozen-lockfile
pnpm run docs
python -m http.server 8080 --bind 127.0.0.1 --directory docs2/build
```

Open `http://127.0.0.1:8080/html/`. Serve the **build directory**, rather than
only `build/html`, so the guide's `../typedoc/index.html` link can reach the
TypeScript reference. Publishing the documentation likewise requires both
sibling directories.

`pnpm run docs` runs TypeDoc, installs `requirements.txt` into `docs2/.venv`
and runs Sphinx with warnings treated as errors. Dependency installation and
Sphinx's external cross-reference inventories need network access.

After dependencies are installed, rebuild just the guides from the repository
root:

```bash
docs2/.venv/bin/sphinx-build -b html -W --keep-going docs2/source docs2/build/html
```

For a fresh strict check, add `-E -a -n`. External inventory downloads require
network access; a DNS or connection failure is an environment failure, not a
clean documentation check. If the default uv cache is not writable, set
`UV_CACHE_DIR` to a writable directory when running the build.

To regenerate just TypeDoc, use `pnpm run docs:typedoc`. To remove generated
output, use `pnpm run docs:clean` from the repository root. No application or
training backend needs to run for documentation builds.

## Write and verify

- Start with the reader's task, its prerequisites and the result they should
  see. Use exact UI labels and copyable commands with an explicit working
  directory.
- Check current behavior against source and the relevant `docs/knowledge/`
  contract. Flag disagreements rather than copying an old plan as fact.
- Keep editing, training and wheel consumption distinct. Explain where project
  files live, who owns them and what a command changes.
- Add new pages to `source/index.rst`; use `:doc:` links between guides. Keep
  reference material separate from step-by-step workflows.
- Run the strict Sphinx build, then open the affected pages. Check navigation,
  tables, code blocks and links to TypeDoc. Run `git diff --check` before handoff.

Sources are under `source/`; generated HTML under `build/` is ignored by Git.
