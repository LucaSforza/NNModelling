import { describe, expect, it } from "vitest";
import { evaluateSignature } from "../type-system/signatureEvaluator";
import { equalDimensions, isDimensionValue, symbol, type DimensionValue } from "../expr";
import type { CompiledTypeSignatureV2 } from "../type-system/model";
import { normalizeParameterValue } from "../type-system/parameterValues";

const tensor = (shape: DimensionValue[], dtype = "float32") => ({ shape, dtype });
const resolved = (value: unknown, type = "int") => normalizeParameterValue(value, type);

describe("signature evaluator", () => {
  it("allocates a variadic group deterministically for three-input Addition", () => {
    const signature: CompiledTypeSignatureV2 = { version: 2, inputs: [{ lower: 2, upper: null, pattern: { kind: "pattern", dims: [{ kind: "wildcard" }] } }], output: { kind: "pattern", dims: [{ kind: "wildcard" }] }, constraints: [{ condition: "all(inputs(0), x => shape(x) == shape(input(0, 0)))", message: "all inputs must agree" }], to_dtype: "dtype(input(0, 0))" };
    expect(evaluateSignature(signature, [tensor([2, 3]), tensor([2, 3]), tensor([2, 3])], {})).toMatchObject({ ok: true, output: { shape: [2, 3], dtype: "float32" } });
  });
  it("evaluates a generic three-input concat signature", () => {
    const signature: CompiledTypeSignatureV2 = { version: 2, inputs: [{ lower: 2, upper: null, pattern: { kind: "pattern", dims: [{ kind: "wildcard" }] } }], output: { kind: "computed_shape", expr: "let axis = axis(-1, rank(input(0, 0))) in replace(shape(input(0, 0)), axis, sum(map(inputs(0), x => dim(x, axis))))" }, constraints: [{ condition: "all(inputs(0), x => rank(x) == rank(input(0, 0)))" }, { condition: "let axis = axis(-1, rank(input(0, 0))) in all(inputs(0), x => remove(shape(x), axis) == remove(shape(input(0, 0)), axis))" }], to_dtype: "dtype(input(0, 0))" };
    expect(evaluateSignature(signature, [tensor([2, 3]), tensor([2, 4]), tensor([2, 5])], {})).toMatchObject({ ok: true, output: { shape: [2, 12] } });
    expect(evaluateSignature(signature, [tensor([2, 3]), tensor([3, 4])], {}).diagnostics).toMatchObject([{ code: "constraint" }]);
  });
  it("keeps symbolic concat sums structural and validates every non-concat axis", () => {
    const signature: CompiledTypeSignatureV2 = { version: 2, inputs: [{ lower: 2, upper: null, pattern: { kind: "pattern", dims: [{ kind: "wildcard" }] } }], output: { kind: "computed_shape", expr: "let axis = axis(-1, rank(input(0, 0))) in replace(shape(input(0, 0)), axis, sum(map(inputs(0), x => dim(x, axis))))" }, constraints: [{ condition: "let axis = axis(-1, rank(input(0, 0))) in all(inputs(0), x => remove(shape(x), axis) == remove(shape(input(0, 0)), axis))" }], to_dtype: "float32" };
    const result = evaluateSignature(signature, [tensor([symbol("B"), symbol("C")]), tensor([symbol("B"), symbol("D")]), tensor([symbol("B"), symbol("E")])], {});
    expect(result.ok).toBe(true);
    expect(equalDimensions(result.output!.shape[1], { tag: "op", op: "add", args: [symbol("C"), symbol("D"), symbol("E")] })).toBe(true);
    expect(evaluateSignature(signature, [tensor([symbol("B"), symbol("C")]), tensor([symbol("Q"), symbol("D")])], {}).ok).toBe(false);
  });
  it("matches scoped symbols, parameter dimensions, spreads and computed dimensions", () => {
    const signature: CompiledTypeSignatureV2 = { version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "symbolic", name: "B", scope: "global" }, { kind: "symbolic", name: "L", scope: "local" }, { kind: "param_ref", name: "width" }, { kind: "computed", expr: "$B + 1" }] } }], output: { kind: "pattern", dims: [{ kind: "symbolic", name: "B", scope: "global" }, { kind: "param_spread", name: "dims" }] }, to_dtype: "float32" };
    const output = evaluateSignature(signature, [tensor([2, 7, 4, 3])], { width: resolved(4), dims: resolved("(8, 9)", "tuple") });
    expect(output).toMatchObject({ ok: true, output: { shape: [2, 8, 9], dtype: "float32" } });
  });
  it("emits suggestions and structured diagnostics for unset, invalid and deferred parameters", () => {
    const signature: CompiledTypeSignatureV2 = { version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "param_ref", name: "width" }] } }], output: { kind: "pattern", dims: [{ kind: "param_spread", name: "dims" }] }, to_dtype: "float32" };
    const result = evaluateSignature(signature, [tensor([4])], { width: normalizeParameterValue(undefined, "int"), dims: normalizeParameterValue(undefined, "tuple") });
    expect(result.suggestions).toMatchObject([{ parameter: "width", value: 4 }]);
    expect(result.diagnostics).toMatchObject([{ code: "deferred_spread", location: "output" }]);
  });
  it("consumes resolved input spreads by declared list length without imposing value equality", () => {
    const signature: CompiledTypeSignatureV2 = { version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "const", value: 2 }, { kind: "param_spread", name: "tail" }] } }], output: { kind: "computed_shape", expr: "shape(input(0, 0))" }, to_dtype: "dtype(input(0, 0))" };
    expect(evaluateSignature(signature, [tensor([2, 8, 9])], { tail: resolved("(3, 4)", "tuple") })).toMatchObject({ ok: true });
  });
  it("handles a positive MatMul contract without operation-name branches", () => {
    const signature: CompiledTypeSignatureV2 = { version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "symbolic", name: "B", scope: "global" }, { kind: "symbolic", name: "M", scope: "local" }, { kind: "symbolic", name: "K", scope: "local" }] } }, { lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "symbolic", name: "B", scope: "global" }, { kind: "symbolic", name: "K", scope: "local" }, { kind: "symbolic", name: "N", scope: "local" }] } }], output: { kind: "pattern", dims: [{ kind: "symbolic", name: "B", scope: "global" }, { kind: "symbolic", name: "M", scope: "local" }, { kind: "symbolic", name: "N", scope: "local" }] }, to_dtype: "float32" };
    expect(evaluateSignature(signature, [tensor([2, 3, 4]), tensor([2, 4, 5])], {})).toMatchObject({ ok: true, output: { shape: [2, 3, 5] } });
  });
  it("honours warning constraints and their declared message", () => {
    const signature: CompiledTypeSignatureV2 = { version: 2, inputs: [], output: { kind: "pattern", dims: [] }, constraints: [{ condition: "false", message: "advisory", severity: "warning", category: "advisory" }], to_dtype: "float32" };
    expect(evaluateSignature(signature, [], {}).diagnostics).toMatchObject([{ message: "advisory", severity: "warning", category: "advisory", location: "constraints/0" }]);
  });
  it("binds unset scalar and spread parameters for later output reuse", () => {
    const signature: CompiledTypeSignatureV2 = { version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "param_ref", name: "width" }, { kind: "param_spread", name: "tail" }] } }], output: { kind: "pattern", dims: [{ kind: "param_ref", name: "width" }, { kind: "param_spread", name: "tail" }] }, to_dtype: "float32" };
    const result = evaluateSignature(signature, [tensor([4, 8, 9])], { width: normalizeParameterValue(undefined, "int"), tail: normalizeParameterValue(undefined, "tuple") });
    expect(result).toMatchObject({ ok: true, output: { shape: [4, 8, 9] }, suggestions: [{ parameter: "width" }, { parameter: "tail" }] });
  });
  it("keeps inferred symbolic parameter dimensions internal", () => {
    const signature: CompiledTypeSignatureV2 = { version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "param_ref", name: "width" }] } }], output: { kind: "pattern", dims: [{ kind: "param_ref", name: "width" }] }, to_dtype: "float32" };
    const result = evaluateSignature(signature, [tensor([symbol("W")])], { width: normalizeParameterValue(undefined, "int") });
    expect(result).toMatchObject({ ok: true, output: { shape: [symbol("W")] }, suggestions: [] });
    const bound = result.bindings.parameters.get("width");
    expect(isDimensionValue(bound) && equalDimensions(bound, symbol("W"))).toBe(true);
  });
  it("validates from_dtype for every input and preserves to_dtype", () => {
    const signature: CompiledTypeSignatureV2 = { version: 2, inputs: [{ lower: 2, upper: 2, pattern: { kind: "pattern", dims: [{ kind: "wildcard" }] } }], output: { kind: "pattern", dims: [{ kind: "wildcard" }] }, from_dtype: "float32", to_dtype: "float64" };
    expect(evaluateSignature(signature, [tensor([2], "float32"), tensor([2], "int64")], {})).toMatchObject({ ok: true, output: { dtype: "float64" }, diagnostics: [{ code: "dtype", severity: "warning" }] });
  });
});
