import { describe, expect, it } from "vitest";
import { normalizeParameterValue } from "../type-system/parameterValues";
import { compileTypeSignature } from "../type-system/schema";

const parameters = { parameterNames: ["features", "dims", "expr"] };

function signature(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    inputs: [{ lower: 1, upper: 1, label: "x", pattern: { kind: "pattern", dims: [{ kind: "symbolic", name: "B", scope: "global" }, { kind: "param_ref", name: "features" }] } }],
    output: { kind: "pattern", dims: [{ kind: "symbolic", name: "B", scope: "global" }, { kind: "computed", expr: "param.features * 2" }] },
    constraints: [{ condition: "param.features > 0", message: "features must be positive", severity: "warning", category: "shape" }],
    from_dtype: "dtype(input(0, 0))",
    to_dtype: "float32",
    ...overrides,
  };
}

describe("v2 type-signature schema", () => {
  it("decodes every shape and dimension union member into immutable data", () => {
    const result = compileTypeSignature(signature({
      inputs: [{ lower: 0, upper: null, pattern: { kind: "pattern", dims: [
        { kind: "const", value: 1 }, { kind: "wildcard" },
        { kind: "symbolic", name: "L", scope: "local" }, { kind: "param_spread", name: "dims" },
      ] } }],
      output: { kind: "einsum", equation: { parameter: "expr" } },
    }), parameters);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.inputs[0].pattern.dims)).toBe(true);
    expect(() => (result.value.inputs as unknown as unknown[]).push({})).toThrow();
  });

  it("accepts computed-shape output and default error constraints", () => {
    const result = compileTypeSignature(signature({ output: { kind: "computed_shape", expr: "shape(input(0, 0))" }, constraints: [{ condition: "true" }] }), parameters);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.constraints?.[0].severity).toBeUndefined();
  });

  it("reports JSON pointers for bounds, expressions, scopes and parameter references", () => {
    const result = compileTypeSignature(signature({
      inputs: [{ lower: 3, upper: 2, pattern: { kind: "pattern", dims: [{ kind: "symbolic", name: "B", scope: "file" }, { kind: "param_ref", name: "missing" }] } }],
      output: { kind: "computed_shape", expr: { ast: "never serialized" } },
      to_dtype: " ",
    }), parameters);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.pointer)).toEqual(expect.arrayContaining([
      "/inputs/0", "/inputs/0/pattern/dims/0/scope", "/inputs/0/pattern/dims/1/name", "/output/expr", "/to_dtype",
    ]));
  });

  it("rejects ambiguous group allocation, duplicate labels and multiple wildcards", () => {
    const group = { lower: 1, upper: null, label: "same", pattern: { kind: "pattern", dims: [{ kind: "wildcard" }, { kind: "wildcard" }] } };
    const result = compileTypeSignature(signature({ inputs: [group, { ...group, pattern: { kind: "pattern", dims: [] } }] }), parameters);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.pointer)).toEqual(expect.arrayContaining(["/inputs", "/inputs/1/label", "/inputs/0/pattern/dims"]));
  });

  it("rejects a symbolic name declared in both scopes", () => {
    const result = compileTypeSignature(signature({ output: { kind: "pattern", dims: [{ kind: "symbolic", name: "B", scope: "local" }] } }), parameters);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((error) => error.pointer)).toContain("/output/dims/0/scope");
  });

  it("rejects expressions that reference symbols absent from the signature", () => {
    const result = compileTypeSignature(signature({
      output: { kind: "computed_shape", expr: "[$UNKNOWN]" },
      constraints: [{ condition: "$UNKNOWN > 0" }],
    }), parameters);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ pointer: "/output/expr", message: expect.stringContaining("unknown symbol '$UNKNOWN' at source span") }),
        expect.objectContaining({ pointer: "/constraints/0/condition", message: expect.stringContaining("unknown symbol '$UNKNOWN' at source span") }),
      ]));
    }
  });

  it("requires canonical null for unbounded groups and a mandatory output dtype", () => {
    const result = compileTypeSignature(signature({ inputs: [{ lower: 1, upper: undefined, pattern: { kind: "pattern", dims: [] } }], to_dtype: undefined }), parameters);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((error) => error.pointer)).toEqual(expect.arrayContaining(["/inputs/0/upper", "/to_dtype"]));
  });

  it("rejects unknown and legacy keys at every structural level", () => {
    const result = compileTypeSignature(signature({
      action: "concat",
      inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "const", value: 2, typo: true }], legacy: true }, unexpected: true }],
      output: { kind: "einsum", equation: { parameter: "expr", action: "einsum" }, legacy: true },
      constraints: [{ condition: "true", action: "warning" }],
    }), parameters);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((error) => error.pointer)).toEqual(expect.arrayContaining([
      "/action", "/inputs/0/unexpected", "/inputs/0/pattern/legacy", "/inputs/0/pattern/dims/0/typo", "/output/legacy", "/output/equation/action", "/constraints/0/action",
    ]));
  });

  it("rejects invalid version, kinds, constants and bounds", () => {
    const result = compileTypeSignature(signature({ version: 3, inputs: [{ lower: -1, upper: -2, pattern: { kind: "unknown", dims: [{ kind: "const", value: 0 }] } }], output: { kind: "unknown" } }), parameters);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((error) => error.pointer)).toEqual(expect.arrayContaining(["/version", "/inputs/0/lower", "/inputs/0/upper", "/inputs/0/pattern/kind", "/output/kind"]));
  });
});

describe("parameter normalization", () => {
  it("keeps unset, invalid, and resolved values distinct without evaluating source", () => {
    expect(normalizeParameterValue("Undefined", "int").status).toBe("unset");
    expect(normalizeParameterValue("2.5", "int")).toMatchObject({ status: "invalid" });
    expect(normalizeParameterValue("(2, 3)", "shape")).toMatchObject({ status: "resolved", value: [2, 3] });
    expect(normalizeParameterValue("__import__('os')", "int")).toMatchObject({ status: "invalid" });
  });

  it("resolves declared scalar, tuple/list and string unions deterministically", () => {
    expect(normalizeParameterValue("2", "int | tuple")).toMatchObject({ status: "resolved", value: 2 });
    expect(normalizeParameterValue("[2, 3]", "int | tuple")).toMatchObject({ status: "resolved", value: [2, 3] });
    expect(normalizeParameterValue([2, 3], "int | tuple")).toMatchObject({ status: "resolved", value: [2, 3] });
    expect(normalizeParameterValue("same", "int | tuple | str")).toMatchObject({ status: "resolved", value: "same" });
    expect(normalizeParameterValue("[2, nope]", "int | tuple")).toMatchObject({ status: "invalid" });
  });
});
