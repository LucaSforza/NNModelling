import { describe, expect, it } from "vitest";
import { compileExpression, equalDimensions, evaluateCompiled, isDimensionValue, isTerm, symbol } from "../expr";

const tensor = { shape: [2, 3, 4], dtype: "float32" } as const;
const run = (source: string, expected: "dimension" | "shape" | "constraint" | "dtype", context = {}) => {
  const compiled = compileExpression(source, expected, { parameterNames: ["axis", "dims", "n", "iterations"] });
  expect(compiled.ok).toBe(true);
  return compiled.ok ? evaluateCompiled(compiled.value, context) : undefined;
};

describe("typed v2 expressions", () => {
  it("keeps arithmetic source readable and returns structured values", () => {
    expect(run("floor(7 / 2) + 1", "dimension")).toMatchObject({ kind: "value", value: 4 });
    expect(run("let x = 3 in x * 4", "dimension")).toMatchObject({ kind: "value", value: 12 });
  });

  it("rejects operators, arity, references, and result kinds with spans", () => {
    expect(compileExpression("unknown(1)", "dimension")).toMatchObject({ ok: false, error: { message: "unknown operator 'unknown'", start: 0 } });
    expect(compileExpression("shape(input(0, 0))", "dtype")).toMatchObject({ ok: false, error: { start: 0, end: 18 } });
    expect(compileExpression("replace([1], 0)", "shape")).toMatchObject({ ok: false, error: { message: "operator 'replace' expects 3 arguments" } });
    expect(compileExpression("param.missing + 1", "dimension", { parameterNames: ["axis"] })).toMatchObject({ ok: false, error: { message: "unknown parameter 'missing'" } });
    expect(compileExpression("shape(1)", "shape")).toMatchObject({ ok: false, error: { message: "operator 'shape' argument 1 expects tensor, got number" } });
    expect(compileExpression("rank([1])", "dimension")).toMatchObject({ ok: false, error: { message: "operator 'rank' argument 1 expects tensor, got shape" } });
    expect(compileExpression("sum(true)", "dimension")).toMatchObject({ ok: false, error: { message: "operator 'sum' argument 1 expects list, got boolean" } });
    expect(compileExpression("replace([1], false, 2)", "shape")).toMatchObject({ ok: false, error: { message: "operator 'replace' argument 2 expects number, got boolean" } });
    expect(compileExpression("[true]", "shape")).toMatchObject({ ok: false });
    expect(compileExpression("let value = true in value", "dimension")).toMatchObject({ ok: false });
    expect(compileExpression("\"left\" > \"right\"", "constraint")).toMatchObject({ ok: false, error: { message: "comparison requires numbers" } });
    expect(compileExpression("if(true, \"x\", \"y\")", "dimension")).toMatchObject({ ok: false });
    expect(compileExpression("coalesce(\"x\", \"y\")", "dimension")).toMatchObject({ ok: false });
  });

  it("handles tensor projection and generic shape primitives", () => {
    expect(run("replace(shape(input(0, 0)), -1, 12)", "shape", { inputs: [[tensor]] })).toMatchObject({ kind: "value", value: [2, 3, 12] });
    expect(run("splice(slice(shape(input(0, 0)), 0, 1), 1, [8, 9])", "shape", { inputs: [[tensor]] })).toMatchObject({ kind: "value", value: [2, 8, 9] });
    expect(run("rank(input(0, 0))", "dimension", { inputs: [[tensor]] })).toMatchObject({ kind: "value", value: 3 });
    expect(run("axis(-1, rank(input(0, 0)))", "dimension", { inputs: [[tensor]] })).toMatchObject({ kind: "value", value: 2 });
    expect(run("axis(-4, rank(input(0, 0)))", "dimension", { inputs: [[tensor]] })).toMatchObject({ kind: "error", message: "axis out of range" });
  });

  it("evaluates parameter, collection, boolean, and control families", () => {
    expect(run("param.axis + 1", "dimension", { params: { axis: 2 } })).toMatchObject({ kind: "value", value: 3 });
    expect(run("sum(map([1, 2, 3], x => x * 2))", "dimension")).toMatchObject({ kind: "value", value: 12 });
    expect(run("all([true, true]) and not false", "constraint")).toMatchObject({ kind: "value", value: true });
    expect(run("if(param.n > 1, 7, 3)", "dimension", { params: { n: 2 } })).toMatchObject({ kind: "value", value: 7 });
    expect(run("if(true, float32, float64)", "dtype")).toMatchObject({ kind: "value", value: "float32" });
  });

  it("indexes scalar and list parameters with scalar broadcasting", () => {
    expect(run("item(param.axis, 3)", "dimension", { params: { axis: 2 } })).toMatchObject({ kind: "value", value: 2 });
    expect(run("item(param.dims, 1)", "dimension", { params: { dims: [3, 5] } })).toMatchObject({ kind: "value", value: 5 });
    expect(run("item(param.dims, 2)", "dimension", { params: { dims: [3, 5] } })).toMatchObject({ kind: "error", message: "item index out of range" });
    expect(run("item(\"wrong\", 0)", "dimension")).toMatchObject({ kind: "error", message: "item requires a dimension or list" });
  });

  it("normalizes dimension scalars and lists for generic collection expressions", () => {
    expect(run("as_list(param.axis)", "shape", { params: { axis: 2 } })).toMatchObject({ kind: "value", value: [2] });
    expect(run("as_list(param.dims)", "shape", { params: { dims: [3, 5] } })).toMatchObject({ kind: "value", value: [3, 5] });
    expect(run("length(as_list(param.axis))", "dimension", { params: { axis: 2 } })).toMatchObject({ kind: "value", value: 1 });
    expect(run("product(param.axis)", "dimension", { params: { axis: 7 } })).toMatchObject({ kind: "value", value: 7 });
    expect(run("product(param.dims)", "dimension", { params: { dims: [3, 5] } })).toMatchObject({ kind: "value", value: 15 });
    expect(run("as_list(\"wrong\")", "shape")).toMatchObject({ kind: "error", message: "as_list requires a dimension or list" });
    expect(compileExpression("length(3)", "dimension")).toMatchObject({ ok: false, error: { message: "operator 'length' argument 1 expects list, got number" } });
    expect(compileExpression("product(\"wrong\")", "dimension")).toMatchObject({ ok: false, error: { message: "product requires a dimension or list" } });
  });

  it("represents Addition, Concat, Flatten, Unflatten, and SequencePool generically", () => {
    const inputs = [[tensor, { shape: [2, 3, 4], dtype: "float32" }]] as const;
    expect(run("all(inputs(0), x => shape(x) == shape(input(0, 0)))", "constraint", { inputs })).toMatchObject({ kind: "value", value: true });
    expect(run("let a = axis(param.axis, rank(input(0, 0))) in replace(shape(input(0, 0)), a, sum(map(inputs(0), x => dim(x, a))) )", "shape", { inputs, params: { axis: -2 } })).toMatchObject({ kind: "value", value: [2, 6, 4] });
    expect(run("[dim(input(0, 0), 0), product(slice(shape(input(0, 0)), 1))]", "shape", { inputs })).toMatchObject({ kind: "value", value: [2, 12] });
    expect(run("splice([dim(input(0, 0), 0)], 1, param.dims)", "shape", { inputs, params: { dims: [3, 4] } })).toMatchObject({ kind: "value", value: [2, 3, 4] });
    expect(run("remove(shape(input(0, 0)), param.axis)", "shape", { inputs, params: { axis: 1 } })).toMatchObject({ kind: "value", value: [2, 4] });
  });

  it("uses the graph-agnostic apply capability for HorizontalRepeat and Repeat", () => {
    const applySubflow = (value: typeof tensor) => ({ kind: "value" as const, value: { ...value, shape: [2, 3, 5] }, trace: ["inner"] });
    const horizontal = run("let t = apply(input(0, 0)) in replace(shape(t), -1, dim(t, -1) * param.n)", "shape", { inputs: [[tensor]], params: { n: 2 }, applySubflow });
    expect(horizontal).toMatchObject({ kind: "value", value: [2, 3, 10] });
    const repeated = run("shape(iterate(param.iterations, input(0, 0), x => apply(x)))", "shape", { inputs: [[tensor]], params: { iterations: 2 }, applySubflow });
    expect(repeated).toMatchObject({ kind: "value", value: [2, 3, 5] });
    expect(run("shape(iterate(129, input(0, 0), x => apply(x)))", "shape", { inputs: [[tensor]], applySubflow })).toMatchObject({ kind: "error", message: "iterate limit exceeded" });
  });

  it("propagates deferred values and callback errors rather than undefined", () => {
    expect(run("dtype(input(0, 0))", "dtype")).toEqual({ kind: "deferred", trace: [] });
    expect(run("shape(apply(input(0, 0)))", "shape", { inputs: [[tensor]], applySubflow: () => ({ kind: "error", message: "inner mismatch", trace: ["node=inner"] }) })).toEqual({ kind: "error", message: "inner mismatch", trace: ["node=inner"] });
  });

  it("resolves declared symbolic and captured dimensions when supplied", () => {
    const compiled = compileExpression("$H + $*", "dimension", { symbols: ["H"] });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(evaluateCompiled(compiled.value, { symbols: { H: 3 }, capturedDimensions: [2, 4] })).toMatchObject({ kind: "value", value: 11 });
    expect(evaluateCompiled(compiled.value, { symbols: { H: 3 } })).toMatchObject({ kind: "deferred" });
  });

  it("composes symbolic dimensions structurally and preserves them through apply and iterate", () => {
    const expression = compileExpression("2 + $H", "dimension", { symbols: ["H"] });
    expect(expression.ok).toBe(true);
    if (!expression.ok) return;
    const symbolic = evaluateCompiled(expression.value);
    expect(symbolic).toMatchObject({ kind: "value" });
    expect(symbolic.kind === "value" && isTerm(symbolic.value) && equalDimensions(symbolic.value, { tag: "op", op: "add", args: [2, symbol("H")] })).toBe(true);
    const sameExpression = evaluateCompiled(expression.value);
    const widthExpression = compileExpression("2 + $W", "dimension", { symbols: ["W"] });
    expect(widthExpression.ok).toBe(true);
    if (!widthExpression.ok || symbolic.kind !== "value" || sameExpression.kind !== "value") return;
    const width = evaluateCompiled(widthExpression.value);
    expect(isDimensionValue(symbolic.value) && isDimensionValue(sameExpression.value) && equalDimensions(symbolic.value, sameExpression.value)).toBe(true);
    expect(width.kind === "value" && isDimensionValue(symbolic.value) && isDimensionValue(width.value) && !equalDimensions(symbolic.value, width.value)).toBe(true);
    expect(equalDimensions(symbol("H", "local"), symbol("H", "global"))).toBe(false);
    expect(isTerm({ tag: "symbol", name: "H" })).toBe(false);
    expect(isTerm({ tag: "op", op: "unknown", args: [] })).toBe(false);
    expect(evaluateCompiled(expression.value, { symbols: { H: 3 } })).toMatchObject({ kind: "value", value: 5 });
    const source = { shape: [2, symbol("H")], dtype: "float32" };
    const applied: typeof source[] = [];
    const applySubflow = (value: typeof source, trace: readonly string[]) => { applied.push(value); return { kind: "value" as const, value, trace }; };
    expect(run("shape(iterate(2, input(0, 0), x => apply(x)))", "shape", { inputs: [[source]], applySubflow })).toMatchObject({ kind: "value", value: source.shape });
    expect(applied).toHaveLength(2);
    expect(applied[1].shape).toEqual(source.shape);
  });
});
