import { describe, expect, it } from "vitest";
import { evaluateEinsumShape } from "../type-system/einsumShape";
import { symbol, type DimensionValue } from "../expr";

const tensor = (shape: DimensionValue[]) => ({ shape, dtype: "float32" });
describe("einsum shape", () => {
  it("infers contracted and diagonal labels", () => {
    expect(evaluateEinsumShape("bij,bjk->bik", [tensor([2, 3, 4]), tensor([2, 4, 5])])).toEqual({ ok: true, shape: [2, 3, 5] });
    expect(evaluateEinsumShape("bii->b", [tensor([2, 3, 3])])).toEqual({ ok: true, shape: [2] });
    expect(evaluateEinsumShape("i,i->", [tensor([3]), tensor([3])])).toEqual({ ok: true, shape: [] });
  });
  it("reports malformed labels and unsupported ellipsis", () => {
    expect(evaluateEinsumShape("...i,i->...", [tensor([2]), tensor([2])])).toMatchObject({ ok: false, message: "einsum ellipsis is unsupported" });
    expect(evaluateEinsumShape("ij,jk->ii", [tensor([2, 3]), tensor([3, 4])])).toMatchObject({ ok: false, message: "einsum output cannot repeat a label" });
    expect(evaluateEinsumShape("i->i->i", [tensor([3])])).toMatchObject({ ok: false, message: "einsum equation requires exactly one '->'" });
    expect(evaluateEinsumShape("i1->i", [tensor([3])])).toMatchObject({ ok: false, message: "einsum labels must be alphabetic" });
  });
  it("compares symbolic labels structurally", () => {
    expect(evaluateEinsumShape("ij,jk->ik", [tensor([2, symbol("H")]), tensor([symbol("H"), 4])])).toMatchObject({ ok: true, shape: [2, 4] });
    expect(evaluateEinsumShape("ij,jk->ik", [tensor([2, symbol("H")]), tensor([symbol("W"), 4])])).toMatchObject({ ok: false, message: expect.stringContaining("incompatible") });
  });
});
