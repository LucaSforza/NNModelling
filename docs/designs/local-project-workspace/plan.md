# Local Project Workspace (Issue #34)

## Goal

Make NNModelling a locally served, project-oriented development environment. A
project is a self-contained directory with its diagram, metadata, Python source,
dataset definitions, stereotypes, reproducible `uv` environment, and training
runs. The existing FastAPI process supplies the local companion capabilities;
the MCP server remains a thin browser RPC proxy. The local start command brings
up both the editor and a usable local training backend.

## Current behavior

- The editor is a static Vite application and saves/loads diagrams through the
  browser file APIs.
- Training is submitted directly to the FastAPI remote-training API and job
  artifacts default to `converted/jobs/`.
- Stereotypes are bundled at build time with `import.meta.glob`.
- Dataset discovery only scans the installed `dataset` package.
- The Python process uses the repository interpreter; no project environment or
  recent-project index exists.
- GitHub Pages publishes the complete editor.

## Scope

1. Create, open, list recent, and restore the last project through companion
   APIs and editor UI.
2. Scaffold and validate the project layout:
   `pyproject.toml`, `uv.lock` when available, `nnmodelling.toml`,
   `model/graph.json`, `stereotypes/`, `src/`, `assets/`, `datasets/`, and
   `runs/`.
3. Bootstrap/synchronize a project-local `.venv` through `uv` without requiring
   users to invoke `uv` manually.
4. Persist diagram saves in the active project and load the active diagram when
   opening/restoring a project.
5. Discover validated project-local stereotype JSON and project-local dataset
   classes derived from `dataset.ds.Dataset`.
6. Make project `src/` importable and execute local training with the project
   interpreter; store artifacts under `<project>/runs/<job-id>`.
7. Store per-project non-secret W&B settings in `nnmodelling.toml`; store the API
   key outside the project and never return it from configuration reads.
8. Serve the built editor from the companion and replace the GitHub Pages editor
   with an installation page containing one install/start command.
9. Let users train without a research cluster: the local start command launches
   the existing training backend on localhost. The Training Sidebar keeps its
   current URL and pairing workflow, so users may connect either to that local
   backend or to an independently managed remote backend.

## Non-goals

- Plugin lifecycle/versioning, cloud project synchronization, package
  publication, collaborative editing, or changing diagram semantics.
- Moving diagram authority into the companion or MCP server.
- Copying large datasets into a project when a reconstructible reference works.
- Replacing remote/Slurm compute support; project-local execution is added while
  existing remote behavior remains compatible.

## Architectural decisions and invariants

1. **Companion boundary.** The existing FastAPI application is extended with
   local project/companion capabilities. A fourth proxy service would duplicate
   authentication, scheduling, and dataset APIs without improving the
   acceptance criteria.
2. **Diagram authority.** The browser remains the live diagram source of truth.
   The companion only persists project files and supplies filesystem/runtime
   capabilities.
3. **MCP boundary.** `mcp-server/` remains a thin browser RPC proxy and is not a
   project manager.
4. **Filesystem safety.** Project IDs resolve only through the companion-owned
   recent-project registry. Client-supplied relative paths may not escape the
   selected root. Atomic writes are used for metadata, registry, secrets, and
   graph persistence.
5. **Secret separation.** `nnmodelling.toml` contains entity, project, tags, and
   run-name template but never the W&B API key. The key is stored in a companion
   state file with owner-only permissions and is redacted from all API models,
   logs, exports, and requested job configs.
6. **Environment isolation.** A project uses `<root>/.venv/bin/python` (platform
   equivalent where needed). `uv sync --project <root>` is invoked by the
   companion. Errors are surfaced as structured API failures and never silently
   fall back to the companion interpreter for a project job.
7. **Compatibility.** Existing non-project training endpoints and repository
   stereotypes/datasets remain functional. Project context is optional at the
   API schema boundary but required by the local project UI.
8. **Trusted local code.** Opening a project opts into executing its Python code.
   Dataset discovery imports only modules below that project's `datasets/` and
   requires subclasses of the canonical `dataset.ds.Dataset` base.
9. **Training connection remains explicit.** Project APIs use the locally served
   companion origin, while the Training Sidebar retains the established backend
   URL, pairing, and authentication contract. Selecting local versus remote
   training means connecting the sidebar to the local backend URL or a remote
   backend URL; the companion does not proxy, route, or duplicate training jobs.

## Data model

`nnmodelling.toml` (versioned):

```toml
schema_version = 1
name = "my-project"
model = "model/graph.json"

[wandb]
entity = ""
project = "NeuralNetworks"
tags = []
run_name_template = ""
mode = "online"
```

The companion state directory defaults to the platform user-data location and
is overrideable for tests/deployment. It contains:

- `projects.json`: normalized roots ordered by last-opened time plus active ID.
- `secrets.json`: project ID to W&B API key, written with mode `0600`.

Public project responses include ID, name, normalized root, model path,
environment state, redacted W&B configuration, and last-opened timestamp.

Job submissions add optional `project_id`. When present, the manager resolves
the project, places the artifact under `runs/`, merges project W&B defaults with
explicit non-secret job overrides, and injects the secret only into the child
process environment.

## Control flow

### Create/open/restore

1. UI calls create/open on the same-origin companion API.
2. Companion validates/scaffolds the root, atomically records it as active and
   recent, then synchronizes its environment.
3. UI requests graph and stereotype catalog, replaces the diagram only after
   both validate, and exposes project status/errors.
4. On editor startup, UI requests the active project and restores it when one is
   recorded; otherwise it shows the project chooser.

### Save

The toolbar serializes `DiagramCore.exportToJson()` and sends it to the active
project graph endpoint. A browser download remains available only as an explicit
export fallback, not as the project save operation.

### Training

The local start command makes the normal backend available on localhost. The
Training Sidebar continues to connect through its current URL/pairing form: the
user chooses the localhost URL for personal-computer training or an existing
remote URL for server/cluster training. For a local project job the UI submits
`project_id`; the manager resolves the project, writes the job to
`runs/<job-id>`, generates Hydra config, and the local executor uses the project
interpreter with project `src/`/`datasets/` import paths. Project W&B settings are
defaults; UI values may override non-secret fields. Existing ownership,
cancellation, integrity, Slurm, and SSE contracts remain intact. No companion
proxy or local/remote routing layer is introduced.

### Runtime catalogs

The companion returns built-in plus project stereotypes in a stable wire form.
Project names that collide with built-ins are rejected explicitly. Dataset
discovery returns built-ins plus validated project subclasses and reports module
import errors without taking down the whole companion.

## UI, command, persistence, compatibility, and errors

- A project chooser precedes the canvas when no project is active. It supports
  create, open by local path, and recent projects.
- The canvas header identifies the active project; Save persists to it. Training
  uses companion/project context and per-project W&B fields.
- The companion provides a single local start entry point that serves the built
  frontend assets and starts the existing training API on localhost. Development
  Vite proxying remains supported. The sidebar still permits a remote backend
  URL when local execution is not desired.
- Invalid TOML, inaccessible paths, missing `uv`, sync failures, malformed
  stereotypes, invalid dataset classes, unavailable project environments, and
  persistence failures produce actionable messages and leave the previous
  active project/diagram unchanged.
- Existing callers without `project_id` retain the current backend behavior.

## Ordered subtasks

### S1 — Companion project lifecycle and catalogs

**Owned files:**

- `docs/designs/local-project-workspace/plan.md`
- `converted/src/backend/project_schema.py`
- `converted/src/backend/projects.py`
- `converted/src/backend/project_env.py`
- `converted/src/backend/stereotype_registry.py`
- `converted/src/backend/dataset_registry.py`
- `converted/src/backend/app.py`
- `converted/src/backend/models.py`
- `converted/src/tests/test_projects.py`

Implement filesystem/state/secrets safety, create/open/recent/active, graph
read/write, environment sync, runtime stereotype and dataset APIs. Preserve all
existing authenticated training APIs.

**Dependencies:** none.

### S2 — Project-aware training execution

**Owned files:**

- `converted/src/backend/manager.py`
- `converted/src/backend/config_service.py`
- `converted/src/backend/executors/local.py`
- `converted/src/tests/test_remote_backend.py`
- `converted/src/tests/test_backend_e2e.py`

Resolve optional project context, store runs in the project, merge W&B settings,
inject secrets only into the subprocess environment, and execute with the
project interpreter/import roots. Preserve legacy and Slurm behavior.

**Dependencies:** S1.

### S3 — Project-oriented editor and training UI

**Owned files:**

- `front-end/src/projects/api.ts`
- `front-end/src/projects/state.svelte.ts`
- `front-end/src/components/ProjectChooser.svelte`
- `front-end/src/components/ProjectStatus.svelte`
- `front-end/src/App.svelte`
- `front-end/src/FlowCanvas.svelte`
- `front-end/src/components/TrainingSidebar.svelte`
- `front-end/src/training/api.ts`
- `front-end/src/core/StereotypeCore.ts`
- `front-end/src/Diagram.svelte.ts`
- `front-end/src/utils.ts`
- `front-end/src/styles/project.css`
- `front-end/src/__tests__/projectApi.test.ts`
- `front-end/src/__tests__/trainingApi.test.ts`
- `front-end/src/__tests__/stereotypeCore.test.ts`

Implement startup restore/chooser, create/open/recent, project Save/load,
project-aware training/W&B settings, and runtime project stereotypes while
retaining built-in fallback, diagram validation, and the current backend
URL/pairing UI for choosing localhost or a remote backend.

**Dependencies:** S1 and S2 API contracts.

### S4 — Local distribution, installation page, and user documentation

**Owned files:**

- `converted/src/backend/cli.py`
- `converted/src/backend/static.py`
- `converted/src/backend/app.py`
- `converted/src/tests/test_companion_cli.py`
- `converted/src/tests/test_install_script.py`
- `converted/pyproject.toml`
- `README.md`
- `.github/workflows/deploy-pages.yml`
- `install/index.html`
- `install/install.sh`
- `docs2/source/project_workspace.rst`
- `docs2/source/index.rst`
- `docs2/source/user_guide.rst`
- `docs2/source/architecture.rst`
- `docs2/source/training_user_guide.rst`
- `docs2/source/training_admin_guide.rst`

Provide the single local start command that serves the editor and starts the
existing backend on localhost, static frontend serving, Pages install site, and
current operational/user documentation. Document that the unchanged Training
Sidebar can instead connect to a remote backend. The install page must not
contain or deploy the editor itself.

**Dependencies:** S1–S3.

## Acceptance criteria

1. UI creates a project with the complete scaffold and does not overwrite a
   non-empty incompatible directory.
2. UI opens an existing valid project and reports invalid metadata without
   replacing the current diagram.
3. Recent projects persist and the last active project restores on restart.
4. Project environment synchronization is companion-driven and its state is
   visible; project jobs fail clearly if it is unavailable.
5. Save writes `model/graph.json`; project jobs write only below `runs/`.
6. Valid local stereotypes appear automatically after opening; malformed or
   colliding definitions are diagnosed.
7. Valid local dataset subclasses are selectable; invalid classes are rejected.
8. Project-local Python targets import and execute with the project interpreter.
9. W&B entity/project/tags/template/mode are project-specific. The API key is
   absent from project files, API reads, logs, exports, and committed fixtures.
10. Project/workspace browser calls use the companion origin/API; MCP remains
    limited to its existing browser RPC role. Training retains its explicit
    backend URL/pairing connection and works with localhost or a remote server.
11. One local command serves NNModelling and starts a localhost training backend;
    Pages publishes only installation instructions with that command.
12. Existing non-project backend, conversion, diagram, auth, training, package
    integrity, and Slurm contracts remain compatible.

## Exact validation commands

Targeted backend:

```bash
cd converted && uv run pytest src/tests/test_projects.py src/tests/test_remote_backend.py -q
cd converted && uv run pytest src/tests/ -m fast -q
```

Targeted frontend:

```bash
pnpm --dir front-end run check
pnpm --dir front-end run test
pnpm --dir front-end run build
pnpm --dir front-end run test:integration:smoke
pnpm --dir front-end run test:integration:convert
```

Documentation/distribution:

```bash
pnpm run docs
uv run --project converted python converted/src/backend/cli.py --help
```

Final integration (when infrastructure is available):

```bash
cd converted && uv run pytest src/tests/ -m service -q
cd converted && uv run pytest src/tests/ -m e2e -q
```

## Integration and review gates

1. Each subtask owns and commits only its listed files after inspecting status,
   diff, and recent log.
2. S2 starts only after S1's API/data contracts are committed; S3 starts only
   after backend contracts are stable; S4 starts after functional integration.
3. Starting with S2, implementation follows TDD: first add or update a focused
   test that fails for the missing behavior, then implement the smallest change
   that makes it pass, then refactor while keeping the targeted and integration
   suites green. Result reports include red/green evidence where practical.
4. `reviewer-openai` reviews S1–S4 as one related change set for correctness,
   security, compatibility, architecture, tests, and issue acceptance. Any
   claimed bug must be supported by a deterministic regression test that
   reproduces the failure; speculative or vibe-based bug findings are not
   actionable. The reviewer may add only such review tests and must not fix
   production code. Because this review includes frontend work, the reviewer
   must load the `nnmodelling-mcp` skill and use its browser-backed workflow to
   verify the editor changes. Glimpse is explicitly excluded and must be
   ignored even if a Glimpse tool/server is available.
5. Findings and their failing regression tests return to the original
   implementer of the affected subtask; the same reviewer is resumed after
   fixes and verifies that the test now passes.
6. The architect verifies the final diff, validations, branch ancestry, and PR
   contents before pushing and opening the authorized pull request.
