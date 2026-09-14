# NNModelling Documentation

Sphinx documentation for the NNModelling project.

## Prerequisites

- Python 3.10+
- `uv` (Python package manager)

## Build

To build the complete documentation set, including the TypeDoc API referenced
by `source/typescript_api.rst`, run this from the repository root:

```bash
pnpm run docs
```

This writes TypeDoc to `docs2/build/typedoc/` and Sphinx HTML to
`docs2/build/html/`.

To build only the Sphinx site:

```bash
cd docs2
uv run make html
```

This Sphinx-only command does not generate the TypeDoc API.

To clean build artifacts:

```bash
uv run make clean
```

## Structure

- `source/` — RST source files
- `build/` — compiled output (git-ignored)
- `Makefile` — Sphinx targets (html, clean, etc.)
- `requirements.txt` — Python dependencies
