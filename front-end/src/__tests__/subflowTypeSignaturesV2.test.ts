import { describe, expect, it } from "vitest";
import horizontalRepeat from "../../../Stereotypes/SubFlows/HorizontalRepeat.json";
import repeat from "../../../Stereotypes/SubFlows/Repeat.json";
import { describeScopeGraph } from "../core/scopeGraph";
import { normalizeParameterValue } from "../type-system/parameterValues";
import { compileTypeSignature } from "../type-system/schema";
import { applySubflow, type SubflowDefinition, type SubflowNodeDefinition } from "../type-system/subflowEvaluator";

const tensor = (shape: number[], dtype = "float32") => ({ shape, dtype });

function compile(raw: unknown, parameterNames: readonly string[] = []) {
  const result = compileTypeSignature(raw, { parameterNames });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.errors.map((error) => `${error.pointer}: ${error.message}`).join("\n"));
  return result.value;
}

function scope(nodes: readonly SubflowNodeDefinition[], edges: readonly { source: string; target: string }[]): SubflowDefinition {
  return { graph: describeScopeGraph(nodes, edges as never, { isEntry: (node) => node.id === "entry" }) };
}

const unary = (output: unknown, toDtype = "dtype(input(0, 0))") => compile({
  version: 2,
  inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "wildcard" }] } }],
  output,
  to_dtype: toDtype,
});

const applied = (signature: ReturnType<typeof compile>, parameters: Record<string, ReturnType<typeof normalizeParameterValue>>, subflow: SubflowDefinition): SubflowDefinition => scope([
  { id: "entry", boundary: true },
  { id: "container-with-an-arbitrary-name", signature, parameters, subflow },
], [{ source: "entry", target: "container-with-an-arbitrary-name" }]);

describe("v2 subflow type signatures", () => {
  it("compiles every declaration without legacy subflow fields", () => {
    for (const stereotype of [horizontalRepeat, repeat]) {
      const signature = compile(stereotype.type_signature, Object.keys(stereotype.params));
      expect(signature.version).toBe(2);
      expect(JSON.stringify(signature)).not.toMatch(/"(?:subflow|action|iterations_param|infer_then_transform|last_dim|multiply)"/);
    }
  });

  it("applies a normal anonymous container through the generic apply capability", () => {
    const normal = unary({ kind: "computed_shape", expr: "shape(apply(input(0, 0)))" }, "dtype(apply(input(0, 0)))");
    const inner = scope([
      { id: "entry", boundary: true },
      { id: "change", signature: unary({ kind: "computed_shape", expr: "replace(shape(input(0, 0)), -1, 5)" }, "float64") },
    ], [{ source: "entry", target: "change" }]);

    expect(applySubflow(applied(normal, {}, inner), tensor([2, 3])).value).toEqual(tensor([2, 5], "float64"));
  });

  it("applies HorizontalRepeat before multiplying its actual final dimension and preserves that dtype", () => {
    const signature = compile(horizontalRepeat.type_signature, Object.keys(horizontalRepeat.params));
    const inner = scope([
      { id: "entry", boundary: true },
      { id: "change", signature: unary({ kind: "computed_shape", expr: "replace(shape(input(0, 0)), -1, 5)" }, "float64") },
    ], [{ source: "entry", target: "change" }]);
    const result = applySubflow(applied(signature, { n: normalizeParameterValue(3, "int") }, inner), tensor([2, 3]));

    expect(result.value).toEqual(tensor([2, 15], "float64"));
  });

  it("iterates a shape-changing nested subflow and takes dtype from the final tensor", () => {
    const signature = compile(repeat.type_signature, Object.keys(repeat.params));
    const inner = scope([
      { id: "entry", boundary: true },
      { id: "grow", signature: unary({ kind: "computed_shape", expr: "replace(shape(input(0, 0)), -1, dim(input(0, 0), -1) + 1)" }, "float64") },
    ], [{ source: "entry", target: "grow" }]);
    const result = applySubflow(applied(signature, { iterations: normalizeParameterValue(3, "int") }, inner), tensor([2, 3]));

    expect(result.value).toEqual(tensor([2, 6], "float64"));
  });

  it("reports an incompatible later iteration without relying on a container name", () => {
    const signature = compile(repeat.type_signature, Object.keys(repeat.params));
    const inner = scope([
      { id: "entry", boundary: true },
      { id: "only-two", signature: compile({ version: 2, inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "const", value: 2 }] } }], output: { kind: "pattern", dims: [{ kind: "const", value: 3 }] }, to_dtype: "float32" }) },
    ], [{ source: "entry", target: "only-two" }]);
    const result = applySubflow(applied(signature, { iterations: normalizeParameterValue(2, "int") }, inner), tensor([2]));

    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toMatchObject([{ nodeId: "only-two", message: expect.stringContaining("expected dimension 2"), trace: expect.arrayContaining(["iteration=2"]) }]);
  });

  it("rejects invalid or unset repeat counts and invalid HorizontalRepeat counts", () => {
    const identity = scope([{ id: "entry", boundary: true }], []);
    const repeatSignature = compile(repeat.type_signature, Object.keys(repeat.params));
    const horizontalSignature = compile(horizontalRepeat.type_signature, Object.keys(horizontalRepeat.params));

    for (const iterations of [normalizeParameterValue(0, "int"), normalizeParameterValue("nope", "int"), normalizeParameterValue(undefined, "int")]) {
      expect(applySubflow(applied(repeatSignature, { iterations }, identity), tensor([2, 3])).value).toBeUndefined();
    }
    expect(applySubflow(applied(horizontalSignature, { n: normalizeParameterValue(0, "int") }, identity), tensor([2, 3])).value).toBeUndefined();
    expect(applySubflow(applied(horizontalSignature, { n: normalizeParameterValue(2, "int") }, identity), tensor([])).value).toBeUndefined();
  });
});
