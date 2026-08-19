import { describe, expect, it } from "vitest";
import { describeScopeGraph } from "../core/scopeGraph";
import { compileTypeSignature } from "../type-system/schema";
import { applySubflow, type SubflowDefinition, type SubflowNodeDefinition } from "../type-system/subflowEvaluator";

const signature = (raw: unknown, parameterNames: readonly string[] = []) => {
  const compiled = compileTypeSignature(raw, { parameterNames });
  if (!compiled.ok) throw new Error(compiled.errors.map((error) => error.message).join(", "));
  return compiled.value;
};
const unary = (output: unknown, toDtype = "float32", parameterNames: readonly string[] = []) => signature({ version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "wildcard" }] } }], output, to_dtype: toDtype }, parameterNames);
const scope = (nodes: readonly SubflowNodeDefinition[], edges: readonly { source: string; target: string; targetHandle?: string }[]): SubflowDefinition => ({ graph: describeScopeGraph(nodes, edges as never, { isEntry: (node) => node.id === "entry" }) });

describe("generic subflow application", () => {
  it("evaluates an unmarked structural entry with the external input", () => {
    const transform = unary({ kind: "computed_shape", expr: "replace(shape(input(0, 0)), -1, 7)" });
    const definition = scope([{ id: "entry", signature: transform }], []);
    const result = applySubflow(definition, { shape: [2, 3], dtype: "float32" });
    expect(result.value).toEqual({ shape: [2, 7], dtype: "float32" });
  });

  it("accepts only one boundary marker at the structural entry", () => {
    const passthrough = unary({ kind: "pattern", dims: [{ kind: "wildcard" }] });
    const misplaced = scope([{ id: "entry", signature: passthrough }, { id: "next", boundary: true, signature: passthrough }], [{ source: "entry", target: "next" }]);
    expect(() => applySubflow(misplaced, { shape: [2], dtype: "float32" })).toThrow("structural entry");
  });

  it("evaluates nested apply once when output and dtype both project it", () => {
    const inner = scope([{ id: "entry", boundary: true }, { id: "inner", signature: unary({ kind: "computed_shape", expr: "replace(shape(input(0, 0)), -1, 5)" }) }], [{ source: "entry", target: "inner" }]);
    const outer = unary({ kind: "computed_shape", expr: "shape(apply(input(0, 0)))" }, "dtype(apply(input(0, 0)))");
    const definition = scope([{ id: "entry", boundary: true }, { id: "outer", signature: outer, subflow: inner }], [{ source: "entry", target: "outer" }]);
    expect(applySubflow(definition, { shape: [2, 3], dtype: "float32" }).value).toEqual({ shape: [2, 5], dtype: "float32" });
  });

  it("reports the internal node and exact iterate step for a later incompatibility", () => {
    const inner = scope([{ id: "entry", boundary: true }, { id: "requires-two", signature: signature({ version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "const", value: 2 }] } }], output: { kind: "pattern", dims: [{ kind: "const", value: 3 }] }, to_dtype: "float32" }) }], [{ source: "entry", target: "requires-two" }]);
    const repeat = unary({ kind: "computed_shape", expr: "shape(iterate(param.iterations, input(0, 0), x => apply(x)))" }, "dtype(iterate(param.iterations, input(0, 0), x => apply(x)))", ["iterations"]);
    const definition = scope([{ id: "entry", boundary: true }, { id: "repeat", signature: repeat, parameters: { iterations: { status: "resolved", value: 2 } }, subflow: inner }], [{ source: "entry", target: "repeat" }]);
    const result = applySubflow(definition, { shape: [2], dtype: "float32" });
    expect(result.diagnostics).toMatchObject([{ nodeId: "requires-two", message: expect.stringContaining("expected dimension 2") }]);
    expect(result.diagnostics[0].trace).toContain("iteration=2");
  });

  it("does not leak local parameter bindings between nodes", () => {
    const first = signature({ version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "param_ref", name: "width" }] } }], output: { kind: "pattern", dims: [{ kind: "const", value: 3 }] }, to_dtype: "float32" }, ["width"]);
    const second = signature({ version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "param_ref", name: "width" }] } }], output: { kind: "pattern", dims: [{ kind: "param_ref", name: "width" }] }, to_dtype: "float32" }, ["width"]);
    const definition = scope([{ id: "entry", boundary: true }, { id: "first", signature: first, parameters: { width: { status: "unset" } } }, { id: "second", signature: second, parameters: { width: { status: "unset" } } }], [{ source: "entry", target: "first" }, { source: "first", target: "second" }]);
    expect(applySubflow(definition, { shape: [2], dtype: "float32" }).value).toEqual({ shape: [3], dtype: "float32" });
  });

  it("keeps a value when a signature produces only warnings", () => {
    const warned = signature({ version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "wildcard" }] } }], output: { kind: "pattern", dims: [{ kind: "wildcard" }] }, constraints: [{ condition: "false", severity: "warning", message: "advisory" }], to_dtype: "float32" });
    const definition = scope([{ id: "entry", signature: warned }], []);
    const result = applySubflow(definition, { shape: [2, 3], dtype: "float32" });
    expect(result.value).toEqual({ shape: [2, 3], dtype: "float32" });
    expect(result.diagnostics).toMatchObject([{ severity: "warning", location: "constraints/0" }]);
  });

  it("preserves nested warnings while applying its value", () => {
    const warned = signature({ version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "wildcard" }] } }], output: { kind: "pattern", dims: [{ kind: "wildcard" }] }, constraints: [{ condition: "false", severity: "warning", message: "nested advisory" }], to_dtype: "float32" });
    const nested = scope([{ id: "entry", boundary: true }, { id: "inner-warning", signature: warned }], [{ source: "entry", target: "inner-warning" }]);
    const outer = unary({ kind: "computed_shape", expr: "shape(apply(input(0, 0)))" }, "dtype(apply(input(0, 0)))");
    const definition = scope([{ id: "entry", boundary: true }, { id: "outer", signature: outer, subflow: nested }], [{ source: "entry", target: "outer" }]);
    const result = applySubflow(definition, { shape: [2, 3], dtype: "float32" });
    expect(result.value).toEqual({ shape: [2, 3], dtype: "float32" });
    expect(result.diagnostics).toMatchObject([{ nodeId: "inner-warning", severity: "warning", message: "nested advisory" }]);
  });

  it("makes globals learned in a nested graph visible to later outer nodes", () => {
    const bindGlobal = signature({ version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "symbolic", name: "G", scope: "global" }] } }], output: { kind: "pattern", dims: [{ kind: "const", value: 3 }] }, to_dtype: "float32" });
    const nested = scope([{ id: "entry", boundary: true }, { id: "bind", signature: bindGlobal }], [{ source: "entry", target: "bind" }]);
    const outer = unary({ kind: "computed_shape", expr: "shape(apply(input(0, 0)))" });
    const requiresGlobal = signature({ version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "symbolic", name: "G", scope: "global" }] } }], output: { kind: "pattern", dims: [{ kind: "wildcard" }] }, to_dtype: "float32" });
    const definition = scope([{ id: "entry", boundary: true }, { id: "outer", signature: outer, subflow: nested }, { id: "requires-global", signature: requiresGlobal }], [{ source: "entry", target: "outer" }, { source: "outer", target: "requires-global" }]);
    const result = applySubflow(definition, { shape: [2], dtype: "float32" });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toMatchObject([{ nodeId: "requires-global", message: expect.stringContaining("global symbol 'G' is 2, got 3") }]);
  });
});
