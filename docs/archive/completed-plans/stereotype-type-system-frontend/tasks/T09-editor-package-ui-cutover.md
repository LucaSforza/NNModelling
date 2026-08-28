---
id: T09
kind: task
status: done
plan: ../plan.md
role: frontend
depends_on: [T08]
parallel_with: []
write_scope:
  - front-end/src/Diagram.svelte.ts
  - front-end/src/core/DiagramCore.ts
  - front-end/src/core/types.ts
  - front-end/src/components/
  - front-end/src/nodes/
  - front-end/src/styles/
  - front-end/src/type-system/
  - front-end/src/__tests__/
  - front-end/tests/
---

# Cut the editor UI over to package metadata and inference

## Objective

Connect the existing Svelte editor surface to the new frontend package type
system. A node carrying `data.package` must be created, edited, displayed and
diagnosed exclusively from its active package definition and
`packageTypeResult`. Legacy nodes may continue using the deprecated path during
coexistence, but the two paths must never be mixed for one node.

This task owns both the visual implementation and its integration logic. It
must preserve the established sidebar layout and styling while replacing its
legacy stereotype assumptions for package nodes.

The visible proof model must also replace the intentionally shallow Transformer
fixture. Reconstruct one attention head from the atomic packages available in
NNModelling, place that head inside a `Horizontal Repeat` subflow, and use its
dynamic join reference to form multi-head attention as the legacy Transformer
diagram does. A single `Linear` standing in for QKV/multi-head attention is not
an acceptable final fixture.

## Evidence and current defect

- `CustomNode.svelte` and `JoinNode.svelte` already use the package result for
  output tooltips and node indicators.
- `Sidebar.svelte`, `SDropdown.svelte`, and the sidebar type-check list still
  resolve `StereotypeCore`, wrap parameter values as `{value, position}`, and
  read `diagram.typeResult` unconditionally.
- Consequently a valid imported package graph can show correct hover tensors
  while the selected-node form displays `Undefined` and the right-side type
  checker reports errors from deprecated `TypeEngine`.
- Existing saved package fixtures use primitive parameter values and exact
  `data.package = {id, version, name}`.

## Authoritative inputs

- Read the initiative plan and migration decision.
- Read `stereotype-lab/design/nnmodelling-integration/README.md`, especially
  frontend-owned dtype selection and kind-driven input/loss behavior.
- Reuse `ParameterDefinition`, `Definition`, `PackageKind`, canonical `DType`,
  defaults and validation from `front-end/src/type-system/packages/types.ts`
  and the copied reference implementation. Do not introduce a second UI-only
  schema.
- Follow the existing markup and CSS in `Sidebar.svelte`, `SDropdown.svelte`,
  `sidebar.css`, and `dropdown.css`; use the supplied screenshot as defect
  evidence, not as a new visual design specification.

## Integration contract

### Package selection

- The create form lists only active entries from `diagram.packageCatalog`.
- Options are grouped as `Layers`, `Loss`, `Subflow`, `Join`, and `Other`.
- Grouping derives from `definition.kind`; `input`, and the layer packages
  whose display names are `Fork` or `Cast`, appear in `Other`. This exception
  is presentation-only and must not enter inference or package loading.
- Selection identity is exact package ID and version. Display name is only the
  option label.
- Creating a package selects node type/cardinality generically from `kind`:
  join creates a join node, subflow a subflow node, and all other kinds a
  standard package node. Do not switch on package IDs.

### Parameter form

- Controls come directly from `definition.parameters` in declaration order.
- `dtype` renders a `<select>` containing exactly its declared `choices`.
- `string` with `choices` also renders a select; boolean renders a checkbox;
  integer/number use numeric controls and preserve numbers; shape/list have a
  small explicit parser/formatter with validation; ordinary strings remain
  text inputs. A stereotype reference may use an active-package select filtered
  by its declared `kind`.
- Defaults come from the definition. Missing required values remain missing;
  never write the string `Undefined`, a legacy wrapper, or an `unknown` dtype.
- Stored package parameters are primitive semantic values. Editing and saving
  must preserve their runtime types.
- View color/width/height come from `definition.view` and remain editable like
  today.

### Diagnostics and type display

- When the selected node has `data.package`, the right-side type checker reads
  only that node's state from `diagram.packageTypeResult` and reports package
  `error`, `fault`, or `unresolved` states. It must not display any entry from
  `diagram.typeResult` for package nodes.
- When no node is selected, the panel may show one combined list, but package
  nodes must be excluded from legacy diagnostics and legacy nodes excluded
  from package diagnostics. Label the source only if needed for clarity.
- Success displays the inferred output shape and dtype in the sidebar as a
  read-only summary. Hover tooltips and sidebar summaries must agree.
- Expected errors, runtime faults and unresolved state remain visually
  distinguishable. Do not flatten faults into inference errors.
- Parameter edits refresh the new scheduler through the existing graph-change
  lifecycle; avoid a parallel mutable form graph.

### Coexistence and persistence

- `data.package` is the sole discriminator for the new editor path.
- Package edits preserve `{id, version, name}` and never resolve by name.
- Legacy nodes remain loadable and editable by the old form for now.
- Do not add behavior to `TypeEngine`, modify backend/PyTorch conversion, or
  attempt legacy project migration.

### Transformer and Horizontal Repeat proof

- Inspect `examples/diagrams/transformer_classifier.json` for the old model's
  containment, residual and multi-head structure. Recreate the semantic intent
  with new package nodes rather than copying its legacy parameter wrappers.
- Build a single attention head as a real nested subflow from the smallest
  compatible atomic package graph available in the current package catalog.
  If an essential atomic primitive is missing, add only the minimal generic
  Lua package(s), using `stereotype-lab` contracts when available; do not hide
  the head behind one monolithic `Linear` or a package-specific scheduler case.
- `core.horizontal-repeat` owns the parallel head composition. Its `times`
  parameter is the head count and its `join` parameter is a dynamic stereotype
  reference of kind `join`.
- The sidebar must render the `join` parameter as a package selector filtered
  to active `join` packages. The selected join's own parameter values must be
  editable and persisted as part of the stereotype reference. At minimum the
  user can select `core.concat` with `dim: -1` or `core.add`; inference must use
  the selected reference, never a UI-only hardcoded join.
- Nested subflow inference must be real: every head receives the same input,
  the head subflow is inferred independently for every branch, and the selected
  join combines the branch outputs. The terminal multi-head shape/dtype must
  follow from these operations.
- Create the finished Transformer through NNModelling's live editor using the
  `.agents/skills/nnmodelling-mcp/SKILL.md` workflow. The agent must operate the
  project via DiagramCore/browser tools, inspect containment and selected-node
  controls, save/export the resulting model, and retain it as the checked-in
  package Transformer fixture. Direct JSON generation alone does not satisfy
  this acceptance path.

## Acceptance criteria

- [ ] Loading each checked-in package model and selecting every node shows its
  real package name and typed parameter values; no field displays `Undefined`.
- [ ] The VAE screenshot defect is gone: Linear parameters show their stored
  numbers and the right panel has no legacy mismatch for the valid graph.
- [ ] Dtype controls show only the choices declared by the selected package and
  saving a new choice updates inference and persists the canonical dtype.
- [ ] The add-package select has the five requested groups and creates Input,
  Layer, Loss, Join and Subflow kinds through generic kind-based code.
- [ ] `Input`, `Fork`, and `Cast` appear under `Other`; no inference code knows
  this UI grouping.
- [ ] A valid package node shows identical shape/dtype in hover and sidebar.
- [ ] Package expected error, unresolved state and Lua fault never appear as a
  legacy TypeEngine diagnostic.
- [ ] Legacy nodes continue to use their current UI and diagnostics during
  coexistence.
- [ ] Export/import round-trips exact package identity and primitive parameter
  types after UI editing.
- [ ] The checked-in Transformer contains an atomic attention-head subflow
  composed through `core.horizontal-repeat`; it does not use a single Linear as
  a placeholder for multi-head attention.
- [ ] Changing Horizontal Repeat's join in the sidebar changes the stored
  dynamic stereotype reference and the actual inferred join result.
- [ ] The Transformer is constructed and saved through live NNModelling using
  the `nnmodelling-mcp` skill, with visible containment and sidebar QA.

## Required tests

- Component/unit coverage for grouping and every parameter-control mapping.
- Regression test for primitive package params versus legacy wrappers.
- Regression test proving package nodes are excluded from legacy diagnostics.
- Creation/edit/save/load tests for at least Input, Linear, Add, Cast and one
  loss/subflow package.
- Browser QA using the checked-in VAE plus one model built from the UI: select
  nodes, change dtype, save/reload, inspect diagnostics, hover the output, and
  capture the final sidebar state.
- Browser/MCP construction test for the atomic-head Transformer: create the
  nested head, configure Horizontal Repeat, choose Concat, save/reload, then
  switch to another compatible join and prove that inference follows it.

## Validation

```bash
pnpm --dir front-end exec vitest run src/__tests__
pnpm --dir front-end check
pnpm --dir front-end test
pnpm --dir front-end build
git diff --check
```

Final browser QA is also required through the NNModelling browser skill. Do
not declare success from RPC data alone; visibly inspect the selected-node
sidebar and type-check panel.

## Required handoff

Commit the implementation. Return the commit, changed files, exact tests and
browser observations, screenshots if useful, and a reuse ledger identifying
which reference schemas/helpers were reused or adapted. State any remaining
legacy UI seam precisely; do not claim that the deprecated engine was deleted.
