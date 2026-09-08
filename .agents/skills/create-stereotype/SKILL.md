---
name: create-stereotype
description: Create a new NNModelling stereotype package with its definition, Lua type inference, PyTorch builder, tests, and validation. Use when adding a new package under stereotype-packages/; do not use for legacy NNTree stereotypes.
---

# Create Stereotype

Create the smallest complete package that matches the user's requested graph
semantics. Preserve the repository's package-only architecture: package
metadata drives topology and parameters, Lua owns frontend type inference, and
the Python entrypoint owns runtime module construction.

## Before editing

- Read the root `AGENTS.md` and the nearest package-local `AGENTS.md`.
- Use the `fff` MCP tools for repository searches. Read an existing package
  with the same `kind` and the nearest relevant tests before choosing a shape.
- Load `use-stereotype-kb` when the request changes or relies on type-system,
  package, Lua, PyTorch, or NNModelling integration semantics.
- Inspect `git status --short` and preserve unrelated user changes.

Ask one concise clarification only when the missing choice changes the public
package contract, such as the package name/ID, topology kind, parameter
semantics, or whether a subflow runs sequentially, in parallel, or once. If a
reasonable choice is clear from nearby packages, state the assumption and
continue.

## Package layout

Create one directory under `stereotype-packages/core/<kebab-case-name>/`:

- `manifest.json`: schema version `1`, exact package `id` and `version`,
  dependencies, and entrypoints.
- `stereotype.json`: display metadata, `kind`, view dimensions/color, and
  primitive parameter definitions.
- `inference.lua`: package-owned frontend inference.
- `pytorch.py`: runtime builder for every non-`input` package. The controlled
  Python loader requires this entrypoint.

Use a new independently identified package, normally `core.<kebab-case-name>`;
do not edit a central catalog. `front-end/src/type-system/bundled/catalog.ts`
discovers core packages by directory convention. Never add package-ID branches
to frontend inference, graph scheduling, parameter handling, or dtype logic.

## Definition and semantics

Choose the correct `kind`: `input`, `layer`, `loss`, `join`, or `subflow`.
Follow the existing `ParameterDefinition` schema; stored parameter values must
be primitive values, not legacy `{value, position}` wrappers.

The Lua entrypoint has the shape:

```lua
return function(context, parameters, services)
  -- Return { status = "success", output = tensor } or
  -- { status = "error", message = "..." }.
end
```

Tensor outputs contain only `shape` and canonical `dtype`. Preserve expected
semantic errors and do not manufacture an unknown or partial tensor. Use the
services supplied by the host for composition:

- A subflow delegates to `services.infer_subflow(...)`.
- A dynamic stereotype delegates to `services.infer_stereotype(...)`.
- A join consumes `context.inputs` in the order supplied by target handles.

For a no-op subflow proxy, call `services.infer_subflow(context.inputs[1])`
exactly once and return its result. Do not duplicate nested graph traversal or
dispatch on a package ID.

The PyTorch entrypoint follows the runtime contract:

```python
def build(parameters, context: BuildContext, services) -> torch.nn.Module:
    ...
```

Use `services.build_subflow()` to construct a nested graph and
`services.build_stereotype(reference)` for referenced packages. A no-op
subflow proxy should build one nested graph and delegate to that module; it is
equivalent to `Repeat` with `times = 1`, but must not create extra copies.

## Tests

Add observable coverage at the narrowest boundary:

- In `front-end/src/__tests__/packageStandardLibrary.test.ts`, import the new
  raw resources, include the package selection, activate it, and test its Lua
  behavior. For “exactly once” composition, count calls to the service.
- In `converted/src/tests/test_package_runtime.py`, exercise the actual
  `pytorch.py` source through `compile_package_graph` with a nested graph when
  the builder is part of the requested behavior.
- Add graph or persistence coverage only when the new kind or definition
  changes those contracts.

Do not add manual catalog registration or unrelated fixtures.

## Verification

Run the focused tests first, then the package gates relevant to the changed
boundary:

```bash
pnpm --dir front-end exec vitest run src/__tests__/packageStandardLibrary.test.ts
pnpm --dir front-end check
pnpm --dir front-end guard:package-only
cd converted && uv run pytest src/tests/test_package_runtime.py -q
cd converted && uv run pytest src/tests/ -m fast -q
git diff --check
```

Run `pnpm --dir front-end build` when package discovery or bundled resources
change. Before handoff, load `verify-task` and exercise the real editor when
the request includes visible package selection or graph behavior. Report
current test results, pre-existing warnings, and any unresolved design choice.
