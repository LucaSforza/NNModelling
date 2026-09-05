import { describe, expect, it } from "vitest";
import { coerceTrainingValue } from "../training/coerce";

describe("coerceTrainingValue", () => {
  it("converts canonical dataset parameter types and aliases", () => {
    expect(coerceTrainingValue("64", "integer")).toBe(64);
    expect(coerceTrainingValue("0.8", "number")).toBe(0.8);
    expect(coerceTrainingValue("true", "boolean")).toBe(true);
    expect(coerceTrainingValue("false", "bool")).toBe(false);
    expect(coerceTrainingValue("hello", "string")).toBe("hello");
  });

  it("keeps incomplete drafts explicit and rejects malformed values", () => {
    expect(coerceTrainingValue("", "integer")).toBeUndefined();
    expect(coerceTrainingValue("", "boolean")).toBeUndefined();
    expect(() => coerceTrainingValue("1.2", "integer")).toThrow(/intero/);
    expect(() => coerceTrainingValue("not-a-number", "number")).toThrow(/numero/);
    expect(() => coerceTrainingValue("yes", "boolean")).toThrow(/true/);
  });
});
