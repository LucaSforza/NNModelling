# Stereotype schema agent guidance

Applies to `Stereotypes/`. Inherit repository-wide rules from `../AGENTS.md`.

Stereotype JSON is the declarative source of truth shared by editor rendering,
tensor inference, NNTree conversion and the Python runtime projection.

## Categories and boundaries

- `Input`: no input handle, one output; exactly one is required at model root.
- `Fork`: ordinary pass-through with input/output handles; canonical internal
  branching entry, but not a replacement for root Input.
- `Layer`: one tensor input and one output.
- `Loss`: conceptual layer producing `[B]`; runtime execution is currently
  terminal as described in `converted/AGENTS.md`.
- `Join`: multiple ordered inputs and one output.
- `Subflow`: container around a recursively compiled internal graph.
- `Module`: reserved generic category.

Inside a subflow, Input may be used only as a declared boundary entry. If none
is declared, the unique topological source becomes the entry. Input and Fork are
equivalent only as boundary pass-throughs; they are not globally interchangeable.

Parameters may use `position: "top"` or `position: "bottom"`; absence renders
them inline. The unused top-level `expr` field must not be reintroduced;
Einsum's `params.expr` remains a user parameter.

## Tensor contracts

- Put tensor behavior in `type_signature`, not in TypeScript name checks.
- Dimension patterns include `const`, `symbolic`, `param_ref`, `wildcard`,
  computed expression dimensions and `param_spread`.
- Computed dimensions use expression strings interpreted by `front-end/src/expr/`.
- Joins use declarative actions such as concat, element-wise, matmul or einsum;
  label ordered inputs where clearer diagnostics are needed.
- Subflows use declarative actions such as identity, infer, repeat or
  infer-then-transform.
- Dtype checks and advisories belong in JSON declarations. Keep warnings distinct
  from hard shape or parameter errors.
- Adding a conventional module should require stereotype and test updates, not a
  new module-name branch in `typeEngine.ts`.

## Verification

Run focused type-engine tests for every signature change. Also run:

```bash
pnpm --dir front-end test
```

If the stereotype changes generated Python configuration or runtime operations,
run the matching conversion/forward integration tier and focused Python tests.
Before final handoff, apply `../.agents/skills/verify-task/SKILL.md` and load a
representative editable diagram in the live editor to verify rendering, tensor
inference, and compilation through the public workflow.
Use `docs2/source/stereotypes.rst`, `docs2/source/type_system.rst`, and
`docs/knowledge/contracts/tensor-types.md` as current references. Historical
type-system plans are preserved under
`docs/archive/completed-plans/tensor-type-system/`.
