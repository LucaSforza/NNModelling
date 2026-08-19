import { describe, expect, it } from "vitest";
import { StereotypeCore, type StereotypeJson } from "../core/StereotypeCore";

const signature = (overrides: Record<string, unknown> = {}) => ({
  version: 2,
  inputs: [],
  output: { kind: "computed_shape", expr: "[1]" },
  to_dtype: "float32",
  ...overrides,
});

const stereotype = (type_signature: unknown, params: StereotypeJson["params"] = {}): StereotypeJson => ({
  params,
  type_signature,
});

describe("stereotype signature loading", () => {
  it.each([
    ["malformed operator", signature({ output: { kind: "computed_shape", expr: "[1] @ [2]" } }), {}, "/output/expr"],
    ["wrong expression result", signature({ output: { kind: "computed_shape", expr: "true" } }), {}, "/output/expr"],
    ["missing expression parameter", signature({ output: { kind: "computed_shape", expr: "[param.width]" } }), {}, "/output/expr"],
    ["malformed legacy numeric text", signature({ output: { kind: "computed_shape", expr: 42 } }), {}, "/output/expr"],
  ] as const)("rejects %s at load time", (_case, typeSignature, params, pointer) => {
    expect(() => new StereotypeCore("/Synthetic.json", stereotype(typeSignature, params))).toThrow(new RegExp(pointer));
  });

  it("keeps serialized expressions as source strings rather than AST data", () => {
    const source = "[param.width]";
    const loaded = new StereotypeCore("/Synthetic.json", stereotype(signature({ output: { kind: "computed_shape", expr: source } }), {
      width: { type: "int", default: "1" },
    }));
    expect(loaded.typeSignature?.output).toEqual({ kind: "computed_shape", expr: source });
  });
});
