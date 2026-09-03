---
id: dataset-driven-input-types
kind: plan
status: ready
updated: 2026-09-03
areas:
  - architecture
  - frontend
  - backend
  - examples
  - integration
  - testing
---

# Dataset-driven model input types

## Goal

Make a diagram a dataset-instantiated family of models: top-level Input nodes
declare only named bindings, the selected dataset supplies their tensor types
and required dimension values, and a trained wheel freezes the resolved input
contract plus model-owned adapters without depending on the dataset.

## Current behavior

`core.input` declares `shape` and `dtype`, while datasets duplicate those
contracts in named batch slots. Graph bindings already support multiple named
top-level Inputs and validate selected dataset compatibility, but the dataset
is not the source of Input inference. Project datasets may also carry an
`inferenceAdapter`, even though portable preprocessing belongs to the exported
model. The VAE dataset and diagram still use these transitional representations.

## Scope

- remove `shape` and `dtype` from the top-level `core.input` contract;
- resolve top-level Input tensors from selected named dataset slots;
- resolve every symbolic dataset dimension through an existing, same-named,
  required positive-integer dataset parameter;
- keep the leading batch dimension dynamic in exported inference artifacts;
- invalidate inference and compilation when dataset selection or dimension
  values change;
- migrate active diagrams and datasets, including the VAE example;
- move portable preprocessing to existing model/package wheel adapters;
- freeze the resolved named input contract in the wheel;
- remove permanent fallback to legacy Input parameters and dataset adapters.

## Non-goals

- a metavariable DSL, shape expressions, inference from observed tensors or a
  general symbolic constraint solver;
- changing target slots, objective bindings or prediction/objective partitioning;
- embedding the training dataset in a wheel;
- redesigning the existing wheel-adapter mechanism;
- preserving two long-lived sources of Input tensor truth.

## Decisions and invariants

- Follow the accepted [dataset-driven Input decision](../../../knowledge/decisions/dataset-driven-input-types.md).
- `DiagramCore` remains the only live graph authority.
- Top-level Input bindings are unique stable identifiers. Internal subflow
  boundaries remain graph-typed and never address dataset slots directly.
- Missing dataset context is unresolved editor state; malformed or incomplete
  dataset resolution is an actionable diagnostic.
- Every symbolic slot dimension has a required same-named integer parameter and
  a positive value before compilation or training.
- Dataset changes invalidate dependent type and compilation caches.
- Wheel and checkpoint loading remain strict and dataset-independent.
- Package behavior stays data-driven; no package-ID or dataset-ID switches.

## Contracts and control flow

```text
diagram Input(inputBinding)
          + selected dataset slot(shape, dtype)
          + resolved integer dimension parameters
          -> dataset-scoped TensorType
          -> normal Lua graph propagation
          -> validated prediction/objective compilation
          -> training
          -> wheel(resolved named input contract + selected adapters)
```

The editor may save and reopen a structurally valid model without a selected
dataset. Complete type validation, bundle compilation and training require a
resolved dataset selection. Export persists only the resulting model input
contract; no dataset source, target or loader becomes part of inference.

## Task graph

| Task | Role | Depends on | May run with | Write scope | Outcome |
| --- | --- | --- | --- | --- | --- |
| [T01](tasks/T01-contract-and-migration.md) | `architecture` | — | — | dataset/Input schemas, migration, focused tests | One versioned dataset-driven boundary |
| [T02](tasks/T02-frontend-inference.md) | `frontend` | T01 | — | frontend graph inference, UI, focused tests | Dataset-scoped live types and diagnostics |
| [T03](tasks/T03-compiler-and-wheel.md) | `backend` | T02 | — | bundle/compiler/trainer/wheel, focused tests | Dataset-instantiated training and autonomous wheel |
| [T04](tasks/T04-migrate-vae-example.md) | `integration` | T02, T03 | — | VAE diagram, dataset, adapter and consumer tests | Migrated and statically validated VAE path |
| [T05](tasks/T05-system-integration.md) | `integration` | T02, T03, T04 | — | all affected implementation packages and focused tests | Cross-system audit and missing integration completed |
| [T06](tasks/T06-final-vae-wheel-qa.md) | `verification` | T05 | — | QA evidence and only fixes routed to owning tasks | Real browser training and wheel interpolation proof |

T05 and T06 intentionally run near the end. T05 owns the complete integration
read-through after subsystem work. T06 requires a fresh, dedicated top-level
browser-owning execution session rather than a delegated child session.

## Integration and review gates

- T01 must settle validation and one-way migration before parallel frontend and
  backend changes begin.
- T02 and T03 must use the same resolved dataset contract and diagnostic terms;
  T03 follows T02 so their shared frontend surfaces cannot race.
- T04 must migrate the VAE dataset before either late integration or real QA.
- T05 reads every affected implementation and test surface, closes missing
  seams, and blocks final QA on duplicate type authorities or stale adapters.
- T06 is acceptance-only. Product defects return to the owning task for a
  focused fix and regression test before the dedicated QA session is rerun.
- Review blocks completion on hidden Input fallback, unresolved symbols entering
  compilation, dataset code or metadata entering the wheel, fixed exported
  batch size, or checkpoint reuse across incompatible structures.

## Acceptance criteria

- [ ] A top-level Input has a binding but no shape/dtype parameters.
- [ ] Without a dataset, dependent inference is unresolved and the diagram
      remains editable and persistable.
- [ ] Selecting a dataset resolves every bound Input from its named slot.
- [ ] Missing bindings, dtypes, same-named integer parameters and positive
      dimension values produce actionable diagnostics before training.
- [ ] Changing a dataset or dimension value recomputes dependent inference and
      recompiles the instantiated model.
- [ ] Multiple Inputs resolve independently and retain deterministic names.
- [ ] Internal subflows remain dataset-independent composition boundaries.
- [ ] The wheel contains the resolved named input contract and model-owned
      adapters, contains no dataset, and accepts a dynamic inference batch axis.
- [ ] Existing diagrams and the VAE dataset migrate once with no permanent
      legacy fallback.
- [ ] The migrated VAE trains from NNModelling and its downloaded wheel performs
      interpolation through public APIs in a clean consumer environment.

## Final verification

Run the package gates recorded by the task handoffs, followed from the
repository root by:

```bash
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir mcp-server test
cd converted && uv run pytest src/tests/ -m fast -q
git diff --check
```

The final acceptance also requires the browser-owned workflow and clean-wheel
interpolation evidence specified by T06; command-only gates cannot replace it.

## Knowledge and archive impact

- Update the package type-system and portable model contracts when behavior
  lands, removing their transitional current-implementation notes.
- Reconcile the older project-owned dataset decision with the accepted
  dataset-driven Input decision without deleting its still-valid ownership,
  security and named-batch rules.
- Update public training and inference documentation after final QA.
- Retain only useful T06 evidence, then archive this initiative when all gates
  pass.
