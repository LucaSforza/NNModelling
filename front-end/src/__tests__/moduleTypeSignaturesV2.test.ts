import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateSignature } from "../type-system/signatureEvaluator";
import { normalizeParameterValue } from "../type-system/parameterValues";
import { compileTypeSignature } from "../type-system/schema";

type ModuleJson = {
  readonly params: Record<string, { readonly type: string }>;
  readonly type_signature: unknown;
};

const modulesDirectory = new URL("../../../Stereotypes/Modules/", import.meta.url);

function moduleJson(name: string): ModuleJson {
  return JSON.parse(readFileSync(new URL(`${name}.json`, modulesDirectory), "utf8")) as ModuleJson;
}

function compileModule(name: string) {
  const definition = moduleJson(name);
  const result = compileTypeSignature(definition.type_signature, {
    parameterNames: Object.keys(definition.params),
  });
  expect(result.ok, name).toBe(true);
  if (!result.ok) throw new Error(result.errors.map((error) => `${error.pointer}: ${error.message}`).join("\n"));
  return result.value;
}

function parameters(name: string, values: Record<string, unknown>) {
  const definition = moduleJson(name);
  return Object.fromEntries(Object.entries(definition.params).map(([key, parameter]) => [
    key,
    normalizeParameterValue(values[key], parameter.type),
  ]));
}

const tensor = (shape: number[], dtype = "float32") => ({ shape, dtype });

describe("v2 module type signatures", () => {
  it("compiles every bundled module without legacy signature fields", () => {
    const names = readdirSync(modulesDirectory).filter((name) => name.endsWith(".json"));
    expect(names).not.toHaveLength(0);
    for (const file of names) {
      const name = file.slice(0, -5);
      const raw = moduleJson(name).type_signature as Record<string, unknown>;
      expect(raw.version, name).toBe(2);
      expect(raw).not.toHaveProperty("kind");
      expect(JSON.stringify(raw), name).not.toContain('"action"');
      compileModule(name);
    }
  });

  it("applies scalar and tuple Conv2d parameters through generic item selection", () => {
    const signature = compileModule("Conv2d");
    const scalar = evaluateSignature(signature, [tensor([2, 3, 10, 12])], parameters("Conv2d", {
      in_channels: 3, out_channels: 5, kernel_size: 3, stride: 2, padding: 1, dilation: 1,
    }));
    expect(scalar).toMatchObject({ ok: true, output: { shape: [2, 5, 5, 6] } });

    const tuple = evaluateSignature(signature, [tensor([2, 3, 10, 12])], parameters("Conv2d", {
      in_channels: 3, out_channels: 5, kernel_size: "(3, 5)", stride: "(2, 3)", padding: "(1, 2)", dilation: "(1, 1)",
    }));
    expect(tuple).toMatchObject({ ok: true, output: { shape: [2, 5, 5, 4] } });
  });

  it("reports an unset source spread and an invalid scalar parameter", () => {
    const unset = evaluateSignature(compileModule("Input"), [], parameters("Input", { out_features: undefined }));
    expect(unset).toMatchObject({ ok: false, diagnostics: [{ code: "deferred_spread", location: "output" }] });

    const invalid = evaluateSignature(compileModule("Linear"), [tensor([2, 4])], parameters("Linear", {
      in_features: "nope", out_features: 3,
    }));
    expect(invalid).toMatchObject({ ok: false, diagnostics: [{ code: "parameter", location: "inputs/0/0" }] });
  });

  it("expands a scalar Input out_features value as one output dimension", () => {
    const result = evaluateSignature(compileModule("Input"), [], parameters("Input", { out_features: 784 }));
    expect(result).toMatchObject({ ok: true, output: { shape: [expect.anything(), 784], dtype: "float32" } });
  });

  it("honours non-default Flatten, Unflatten, and SequencePool axes", () => {
    const flattened = evaluateSignature(compileModule("Flatten"), [tensor([2, 3, 4, 5])], parameters("Flatten", {
      start_dim: 1, end_dim: 2,
    }));
    expect(flattened).toMatchObject({ ok: true, output: { shape: [2, 12, 5] } });
    const reversed = evaluateSignature(compileModule("Flatten"), [tensor([2, 3, 4, 5])], parameters("Flatten", {
      start_dim: 3, end_dim: 1,
    }));
    expect(reversed).toMatchObject({ ok: false, diagnostics: [{ code: "constraint" }] });

    const unflattened = evaluateSignature(compileModule("Unflatten"), [tensor([2, 12, 5])], parameters("Unflatten", {
      dim: -2, unflattened_size: "(3, 4)",
    }));
    expect(unflattened).toMatchObject({ ok: true, output: { shape: [2, 3, 4, 5] } });

    const mismatch = evaluateSignature(compileModule("Unflatten"), [tensor([2, 12, 5])], parameters("Unflatten", {
      dim: 1, unflattened_size: "(2, 5)",
    }));
    expect(mismatch).toMatchObject({ ok: false, diagnostics: [{ code: "constraint" }] });

    const rankTwo = evaluateSignature(compileModule("SequencePool"), [tensor([2, 6])], parameters("SequencePool", { dim: 1 }));
    expect(rankTwo).toMatchObject({ ok: true, output: { shape: [2, 6] } });
    const pooled = evaluateSignature(compileModule("SequencePool"), [tensor([2, 3, 4])], parameters("SequencePool", { dim: 2 }));
    expect(pooled).toMatchObject({ ok: true, output: { shape: [2, 3] } });
  });

  it("selects Upsample size before scale_factor and handles scalar and tuple values", () => {
    const signature = compileModule("Unsample");
    expect(evaluateSignature(signature, [tensor([2, 3, 10, 12])], parameters("Unsample", {
      size: 20, scale_factor: 3,
    }))).toMatchObject({ ok: true, output: { shape: [2, 3, 20, 20] } });
    expect(evaluateSignature(signature, [tensor([2, 3, 10, 12])], parameters("Unsample", {
      size: "(20, 30)", scale_factor: "(9, 9)",
    }))).toMatchObject({ ok: true, output: { shape: [2, 3, 20, 30] } });
    expect(evaluateSignature(signature, [tensor([2, 3, 10, 12])], parameters("Unsample", {
      size: undefined, scale_factor: "(2, 3)",
    }))).toMatchObject({ ok: true, output: { shape: [2, 3, 20, 36] } });
    expect(evaluateSignature(signature, [tensor([2, 3, 11, 12])], parameters("Unsample", {
      size: undefined, scale_factor: "(1.5, 2)",
    }))).toMatchObject({ ok: true, output: { shape: [2, 3, 16, 24] } });
    const unset = evaluateSignature(signature, [tensor([2, 3, 10, 12])], parameters("Unsample", {
      size: undefined, scale_factor: undefined,
    }));
    expect(unset.ok).toBe(false);
    expect(unset.diagnostics.some((diagnostic) => diagnostic.code === "computed" && diagnostic.location === "output")).toBe(true);
  });

  it("emits warnings only for invalid advisory conditions and errors for invalid contracts", () => {
    const conv = compileModule("Conv2d");
    const validConv = evaluateSignature(conv, [tensor([2, 3, 10, 12])], parameters("Conv2d", {
      in_channels: 3, out_channels: 5, kernel_size: 3, stride: 1, padding: 0, dilation: 1,
    }));
    expect(validConv.diagnostics).toHaveLength(0);
    const oversized = evaluateSignature(conv, [tensor([2, 3, 10, 12])], parameters("Conv2d", {
      in_channels: 3, out_channels: 5, kernel_size: "(11, 3)", stride: 1, padding: 1, dilation: 1,
    }));
    expect(oversized).toMatchObject({ ok: true, diagnostics: [{ severity: "warning", category: "perf" }] });

    const safeDropout = evaluateSignature(compileModule("Dropout"), [tensor([2, 3])], parameters("Dropout", { p: 0.4 }));
    expect(safeDropout.diagnostics).toHaveLength(0);
    const highDropout = evaluateSignature(compileModule("Dropout"), [tensor([2, 3])], parameters("Dropout", { p: 0.8 }));
    expect(highDropout).toMatchObject({ ok: true, diagnostics: [{ severity: "warning", category: "perf" }] });
    const invalidDropout = evaluateSignature(compileModule("Dropout"), [tensor([2, 3])], parameters("Dropout", { p: 1.2 }));
    expect(invalidDropout.ok).toBe(false);
    expect(invalidDropout.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
  });

  it("enforces module-specific rank, channel, normalization, positional, and head constraints", () => {
    expect(evaluateSignature(compileModule("BatchNorm2d"), [tensor([2, 3, 4])], parameters("BatchNorm2d", { num_features: 3 })).ok).toBe(false);
    expect(evaluateSignature(compileModule("BatchNorm1d"), [tensor([2, 3, 4, 5])], parameters("BatchNorm1d", { num_features: 3 })).ok).toBe(false);
    expect(evaluateSignature(compileModule("LayerNorm"), [tensor([2, 3, 4])], parameters("LayerNorm", { normalized_shape: "(3, 4)" })).ok).toBe(true);
    expect(evaluateSignature(compileModule("LayerNorm"), [tensor([2, 3, 4])], parameters("LayerNorm", { normalized_shape: "(2, 4)" })).ok).toBe(false);
    expect(evaluateSignature(compileModule("PositionalEncoding"), [tensor([2, 6, 8])], parameters("PositionalEncoding", { d_model: 8, max_len: 5 })).ok).toBe(false);
    expect(evaluateSignature(compileModule("MultiheadAttention"), [tensor([2, 4, 8])], parameters("MultiheadAttention", { embed_dim: 8, num_heads: 3 })).ok).toBe(false);
  });

  it("keeps documented unary declarations narrow where the Python API needs extra tensors", () => {
    for (const name of ["MultiheadAttention", "Transformer", "TransformerDecoderLayer"]) {
      const result = evaluateSignature(compileModule(name), [tensor([2, 4, 8])], parameters(name, {
        embed_dim: 8, d_model: 8, num_heads: 2, nhead: 2,
      }));
      expect(result.ok, `${name} only declares its supported unary tensor projection; query/key/value, src/tgt, and decoder memory are runtime gaps`).toBe(true);
    }
  });
});
