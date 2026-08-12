# Task review — Full Tensor Type System Review

**Delegate to**: `@reviewer`  
**Depends on**: ALL frontend tasks (1–4) must be complete  
**Estimated effort**: Review pass over 5 files

---

## Objective

Review the complete tensor type system implementation against the design documents. Verify correctness, code quality, and test coverage.

---

## Files to Review

| File | Created/Modified | What to Check |
|------|-----------------|---------------|
| `front-end/src/conversion/tensortypes.ts` | CREATED (task 1) | All interfaces exported; no runtime logic; JSDoc comments |
| `front-end/src/stereotype.ts` | MODIFIED (task 2) | `type_signature` parsed correctly; `$` stripped from symbolic names; no regression in existing behavior |
| `Stereotypes/Modules/Input.json` | MODIFIED (task 2) | Valid JSON; `type_signature` matches spec |
| `Stereotypes/Modules/Linear.json` | MODIFIED (task 2) | Valid JSON; `type_signature` matches spec |
| `Stereotypes/Modules/ReLU.json` | MODIFIED (task 2) | Valid JSON; `type_signature` matches spec |
| `front-end/src/conversion/typeEngine.ts` | CREATED (task 3) | Data-driven engine; no hardcoded module names; correct constraint solving |
| `front-end/src/__tests__/typeEngine.test.ts` | CREATED (task 4) | All test groups covered; tests pass |
| `front-end/src/__tests__/helpers.ts` | MODIFIED (task 4) | New helpers are correct and exported |

---

## Review Checklist

### Phase 1 — Architecture Compliance

- [ ] `tensortypes.ts` exports only types/interfaces (no runtime code)
- [ ] `typeEngine.ts` has NO hardcoded module names (`Linear`, `ReLU`, `Conv2d`, etc.)
- [ ] `typeEngine.ts` has NO hardcoded category checks (`isJoin`, `isInput`, `isLoss`)
- [ ] `typeEngine.ts` does NOT import or depend on Svelte, SvelteFlow, or DOM APIs
- [ ] `typeEngine.ts` is a pure function — `infer()` does not mutate the diagram
- [ ] `stereotype.ts` changes are additive only (no removed fields, no changed method signatures)
- [ ] Existing files (`nnTree.ts`, `utils.ts`, `Diagram.svelte.ts`, `FlowCanvas.svelte`, `Sidebar.svelte`) are UNCHANGED
- [ ] All Python files in `converted/` are UNCHANGED

### Phase 2 — Implementation Correctness

- [ ] `TypeSignature` parsing from JSON correctly strips `$` prefix from symbolic dim names
- [ ] `$` stripping is applied to both `input` patterns (single and array) and `output` patterns
- [ ] `TypeSignature` parsing is a deep clone (doesn't mutate the loaded JSON data)
- [ ] `topologicalSort` handles cycles gracefully (warning, not crash)
- [ ] `patternMatch` correctly handles all four `DimKind` cases
- [ ] `patternMatch` correctly unifies symbolic dimensions (same name → must have same value)
- [ ] `patternMatch` correctly captures wildcard-consumed dimensions
- [ ] `resolvePattern` correctly substitutes bindings into output pattern
- [ ] `resolvePattern` correctly substitutes captured dimensions at wildcard position
- [ ] `resolveParamRef` handles `"Undefined"`, `"None"`, `undefined`, numeric strings, and actual numbers
- [ ] Dtype propagation: if `dtype.output` is set, use it; otherwise inherit from input
- [ ] Dtype checking: if `dtype.input` is set, verify match
- [ ] Input nodes (empty input pattern `[]`) are handled correctly as sources
- [ ] Join and subflow `kind` emit TODO warnings without crashing

### Phase 3 — Test Quality

- [ ] All tests in `typeEngine.test.ts` pass: `npx vitest run typeEngine`
- [ ] Happy path tests cover: Input alone, Input→Linear, Input→Linear→ReLU
- [ ] Error tests cover: in_features mismatch, dtype mismatch, unresolved params
- [ ] Edge case tests cover: missing type_signature, disconnected nodes, empty diagram, join nodes
- [ ] Error messages include `nodeId` and are human-readable
- [ ] `it.skip()` is used for Phase 2+ features, not missing tests
- [ ] Test helpers in `helpers.ts` are exported and correctly typed

### Phase 4 — Regression

- [ ] All existing vitest tests pass: `npx vitest run`
- [ ] `npx svelte-check` passes with no new errors
- [ ] `npm run dev` starts without errors
- [ ] Diagram load/save still works in the browser
- [ ] NNTree compilation still produces correct output for existing diagrams

### Phase 5 — Code Quality

- [ ] Functions are small (< 40 lines each)
- [ ] No deeply nested conditionals (> 3 levels)
- [ ] No `any` types except where strictly necessary (e.g., `params: Record<string, any>`)
- [ ] All public methods have JSDoc comments
- [ ] No `console.log` left in production code
- [ ] No commented-out code
- [ ] Consistent naming with existing codebase (camelCase for functions/variables, PascalCase for classes/interfaces)

---

## What to Report

After review, return:

1. **PASS/FAIL** for each checklist item
2. **Issues found** with file path and line number for each
3. **One-sentence overall verdict**: "APPROVED" or "CHANGES REQUESTED"
4. If CHANGES REQUESTED: list of specific fixes needed, ordered by priority

---

## How Issues Are Handled

- `@reviewer` reports issues → `@architect` (me) decides which agent to re-spawn
- Minor issues (typos, missing comments): architect may fix directly
- Logic issues: architect re-spawns `@frontend` with specific fix instructions
- After fixes: re-review (only the changed files)

---

## Reference Documents

- `docs/archive/completed-plans/tensor-type-system/01-architecture.md` — Full architectural design
- `docs/archive/completed-plans/tensor-type-system/frontend-1-tensortypes.md` — Type model spec
- `docs/archive/completed-plans/tensor-type-system/frontend-2-stereotype-json.md` — Stereotype extension spec
- `docs/archive/completed-plans/tensor-type-system/frontend-3-typeEngine.md` — Engine algorithm spec
- `docs/archive/completed-plans/tensor-type-system/frontend-4-typeEngine-test.md` — Test spec
