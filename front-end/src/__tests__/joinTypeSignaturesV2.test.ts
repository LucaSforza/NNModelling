import { describe, expect, it } from "vitest";
import addition from "../../../Stereotypes/Joins/Addition.json";
import concat from "../../../Stereotypes/Joins/Concat.json";
import einsum from "../../../Stereotypes/Joins/Einsum.json";
import maskedScaledDotProduct from "../../../Stereotypes/Joins/MaskedScaledDotProduct.json";
import matMul from "../../../Stereotypes/Joins/MatMul.json";
import scaledDotProduct from "../../../Stereotypes/Joins/ScaledDotProduct.json";
import { evaluateSignature } from "../type-system/signatureEvaluator";
import { normalizeParameterValue } from "../type-system/parameterValues";
import { compileTypeSignature } from "../type-system/schema";

const joins = [addition, concat, einsum, maskedScaledDotProduct, matMul, scaledDotProduct];
const tensor = (shape: number[], dtype = "float32") => ({ shape, dtype });

function compile(stereotype: (typeof joins)[number]) {
  const result = compileTypeSignature(stereotype.type_signature, {
    parameterNames: Object.keys(stereotype.params),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

describe("v2 Join type signatures", () => {
  it("compiles every Join with no legacy semantic fields", () => {
    for (const stereotype of joins) {
      const signature = compile(stereotype);
      expect(signature.version).toBe(2);
      expect(JSON.stringify(signature)).not.toMatch(/"(?:join|action|dim_expr|einsum_param)"/);
    }
  });

  it("evaluates three-input Addition and rejects a shape mismatch", () => {
    const signature = compile(addition);
    expect(evaluateSignature(signature, [tensor([2, 3]), tensor([2, 3]), tensor([2, 3])], {})).toMatchObject({
      ok: true,
      output: { shape: [2, 3], dtype: "float32" },
    });
    expect(evaluateSignature(signature, [tensor([2, 3]), tensor([2, 4])], {}).diagnostics).toMatchObject([
      { code: "constraint", message: "Addition inputs must have identical shapes" },
    ]);
  });

  it("evaluates three-input Concat and rejects invalid ranks and axes", () => {
    const signature = compile(concat);
    const params = { dim: normalizeParameterValue("-1", "int") };
    expect(evaluateSignature(signature, [tensor([2, 3]), tensor([2, 4]), tensor([2, 5])], params)).toMatchObject({
      ok: true,
      output: { shape: [2, 12], dtype: "float32" },
    });
    expect(evaluateSignature(signature, [tensor([2, 3]), tensor([2, 4, 5])], params).ok).toBe(false);
    expect(evaluateSignature(signature, [tensor([2, 3]), tensor([2, 4])], { dim: normalizeParameterValue("2", "int") }).ok).toBe(false);
  });

  it("uses ordered MatMul groups with strict equal batch prefixes", () => {
    const signature = compile(matMul);
    expect(evaluateSignature(signature, [tensor([2, 7, 3, 4]), tensor([2, 7, 4, 5])], {})).toMatchObject({
      ok: true,
      output: { shape: [2, 7, 3, 5] },
    });
    expect(evaluateSignature(signature, [tensor([2, 7, 3, 4]), tensor([2, 8, 4, 5])], {}).ok).toBe(false);
    expect(evaluateSignature(signature, [tensor([2, 7, 3, 4]), tensor([2, 7, 5, 4])], {}).ok).toBe(false);
  });

  it("evaluates attention signatures with explicit d_model and dtype contracts", () => {
    const params = { d_model: normalizeParameterValue("4", "int") };
    for (const stereotype of [scaledDotProduct, maskedScaledDotProduct]) {
      const signature = compile(stereotype);
      expect(evaluateSignature(signature, [tensor([2, 3, 4]), tensor([2, 5, 4])], params)).toMatchObject({
        ok: true,
        output: { shape: [2, 3, 5], dtype: "float32" },
      });
      expect(evaluateSignature(signature, [tensor([2, 3, 4]), tensor([2, 5, 3])], params).ok).toBe(false);
    }
  });

  it("selects Einsum only from its output kind, independent of stereotype name", () => {
    const signature = compile({ ...einsum, name: "RenamedTensorContraction" });
    const params = { expr: normalizeParameterValue("bij,bjk->bik", "string") };
    expect(evaluateSignature(signature, [tensor([2, 3, 4]), tensor([2, 4, 5])], params)).toMatchObject({
      ok: true,
      output: { shape: [2, 3, 5], dtype: "float32" },
    });
    expect(evaluateSignature(signature, [tensor([2, 3, 4])], params).ok).toBe(false);
  });
});
