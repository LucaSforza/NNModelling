/**
 * @file Unit tests for the expression evaluator.
 *
 * Tests cover tokenizer, parser, evaluator, and error handling.
 * No Svelte dependencies — pure function tests.
 */

import { describe, it, expect } from "vitest";
import { compileExpression, evaluateCompiled, parseExpr, ParseError } from "../expr/index";
import { tokenize } from "../expr/tokenizer";
import { parse } from "../expr/parser";

// ── Helpers ──────────────────────────────────────────────────────────────────

function evalStr(source: string, overrides?: {
  env?: Record<string, number>;
  captured?: number[];
  params?: Record<string, unknown>;
}): number | undefined {
  const values = overrides ?? {};
  const params = Object.fromEntries(Object.entries(values.params ?? {}).map(([name, value]) => {
    const number = typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    return [name, Number.isFinite(number) ? number : value];
  }));
  const compiled = compileExpression(source, "dimension", {
    parameterNames: Object.keys(params),
    symbols: Object.keys(values.env ?? {}),
  });
  if (!compiled.ok) return undefined;
  const result = evaluateCompiled(compiled.value, {
    params,
    symbols: values.env,
    capturedDimensions: values.captured,
  });
  return result.kind === "value" && typeof result.value === "number" ? result.value : undefined;
}

// ── Tokenizer Tests ─────────────────────────────────────────────────────────

describe("Expression Tokenizer", () => {
  it("tokenizes a number", () => {
    const tokens = tokenize("42");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe("NUMBER");
    expect(tokens[0].value).toBe("42");
  });

  it("tokenizes $H + 1", () => {
    const tokens = tokenize("$H + 1");
    expect(tokens).toHaveLength(3);
    expect(tokens[0].kind).toBe("DOLLAR_IDENT");
    expect(tokens[0].value).toBe("H");
    expect(tokens[1].kind).toBe("PLUS");
    expect(tokens[2].kind).toBe("NUMBER");
    expect(tokens[2].value).toBe("1");
  });

  it("tokenizes 2 * padding", () => {
    const tokens = tokenize("2 * padding");
    expect(tokens).toHaveLength(3);
    expect(tokens[0].kind).toBe("NUMBER");
    expect(tokens[0].value).toBe("2");
    expect(tokens[1].kind).toBe("STAR");
    expect(tokens[2].kind).toBe("IDENTIFIER");
    expect(tokens[2].value).toBe("padding");
  });

  it("tokenizes floor($H / 2)", () => {
    const tokens = tokenize("floor($H / 2)");
    expect(tokens).toHaveLength(6);
    expect(tokens[0].kind).toBe("IDENTIFIER");
    expect(tokens[0].value).toBe("floor");
    expect(tokens[1].kind).toBe("LPAREN");
    expect(tokens[2].kind).toBe("DOLLAR_IDENT");
    expect(tokens[2].value).toBe("H");
    expect(tokens[3].kind).toBe("SLASH");
    expect(tokens[4].kind).toBe("NUMBER");
    expect(tokens[4].value).toBe("2");
    expect(tokens[5].kind).toBe("RPAREN");
  });

  it("tokenizes $* as DOLLAR_STAR", () => {
    const tokens = tokenize("$*");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe("DOLLAR_STAR");
    expect(tokens[0].value).toBe("$*");
  });

  it("tokenizes (a + b) with parens", () => {
    const tokens = tokenize("(a + b)");
    expect(tokens).toHaveLength(5);
    expect(tokens[0].kind).toBe("LPAREN");
    expect(tokens[1].kind).toBe("IDENTIFIER");
    expect(tokens[1].value).toBe("a");
    expect(tokens[2].kind).toBe("PLUS");
    expect(tokens[3].kind).toBe("IDENTIFIER");
    expect(tokens[3].value).toBe("b");
    expect(tokens[4].kind).toBe("RPAREN");
  });

  it("tokenizes a // b as floor division", () => {
    const tokens = tokenize("a // b");
    expect(tokens).toHaveLength(3);
    expect(tokens[0].kind).toBe("IDENTIFIER");
    expect(tokens[0].value).toBe("a");
    expect(tokens[1].kind).toBe("FLOOR_DIV");
    expect(tokens[1].value).toBe("//");
    expect(tokens[2].kind).toBe("IDENTIFIER");
    expect(tokens[2].value).toBe("b");
  });

  it("tokenizes a % b", () => {
    const tokens = tokenize("a % b");
    expect(tokens).toHaveLength(3);
    expect(tokens[0].kind).toBe("IDENTIFIER");
    expect(tokens[1].kind).toBe("PERCENT");
    expect(tokens[2].kind).toBe("IDENTIFIER");
  });

  it("throws on lone $", () => {
    expect(() => tokenize("$")).toThrow(ParseError);
    expect(() => tokenize("$ + 1")).toThrow(ParseError);
  });

  it("tokenizes $B and $W separately", () => {
    const tokens = tokenize("$B + $W");
    expect(tokens).toHaveLength(3);
    expect(tokens[0].kind).toBe("DOLLAR_IDENT");
    expect(tokens[0].value).toBe("B");
    expect(tokens[1].kind).toBe("PLUS");
    expect(tokens[2].kind).toBe("DOLLAR_IDENT");
    expect(tokens[2].value).toBe("W");
  });
});

// ── Parser Tests ────────────────────────────────────────────────────────────

describe("Expression Parser", () => {
  it("parses a number literal", () => {
    const ast = parseExpr("42");
    expect(ast).toEqual({ kind: "number", value: 42 });
  });

  it("parses $H as symbolic variable", () => {
    const ast = parseExpr("$H");
    expect(ast).toEqual({ kind: "variable", name: "H", isSymbolic: true });
  });

  it("parses padding as non-symbolic variable", () => {
    const ast = parseExpr("padding");
    expect(ast).toEqual({
      kind: "variable",
      name: "padding",
      isSymbolic: false,
    });
  });

  it("parses $* as wildcard_product", () => {
    const ast = parseExpr("$*");
    expect(ast).toEqual({ kind: "wildcard_product" });
  });

  it("parses $H + 1 as binary operation", () => {
    const ast = parseExpr("$H + 1");
    expect(ast).toEqual({
      kind: "binary",
      op: "+",
      left: { kind: "variable", name: "H", isSymbolic: true },
      right: { kind: "number", value: 1 },
    });
  });

  it("parses a + b * c with correct precedence", () => {
    const ast = parseExpr("a + b * c");
    expect(ast.kind).toBe("binary");
    if (ast.kind === "binary") {
      expect(ast.op).toBe("+");
      expect(ast.left).toEqual({ kind: "variable", name: "a", isSymbolic: false });
      expect(ast.right.kind).toBe("binary");
      if (ast.right.kind === "binary") {
        expect(ast.right.op).toBe("*");
        expect(ast.right.left).toEqual({
          kind: "variable",
          name: "b",
          isSymbolic: false,
        });
        expect(ast.right.right).toEqual({
          kind: "variable",
          name: "c",
          isSymbolic: false,
        });
      }
    }
  });

  it("parses (a + b) * c with correct grouping", () => {
    const ast = parseExpr("(a + b) * c");
    expect(ast.kind).toBe("binary");
    if (ast.kind === "binary") {
      expect(ast.op).toBe("*");
      expect(ast.left.kind).toBe("binary");
      if (ast.left.kind === "binary") {
        expect(ast.left.op).toBe("+");
      }
      expect(ast.right).toEqual({ kind: "variable", name: "c", isSymbolic: false });
    }
  });

  it("parses -x as unary minus", () => {
    const ast = parseExpr("-x");
    expect(ast).toEqual({
      kind: "unary",
      op: "-",
      operand: { kind: "variable", name: "x", isSymbolic: false },
    });
  });

  it("parses floor($H / 2) as function call", () => {
    const ast = parseExpr("floor($H / 2)");
    expect(ast).toEqual({
      kind: "call",
      name: "floor",
      args: [
        {
          kind: "binary",
          op: "/",
          left: { kind: "variable", name: "H", isSymbolic: true },
          right: { kind: "number", value: 2 },
        },
      ],
    });
  });

  it("parses floor($H + 2*padding) as complex function call", () => {
    const ast = parseExpr("floor($H + 2*padding)");
    expect(ast.kind).toBe("call");
    if (ast.kind === "call") {
      expect(ast.name).toBe("floor");
      expect(ast.args).toHaveLength(1);
      expect(ast.args[0].kind).toBe("binary");
    }
  });

  it("parses max(a, b) as function call with 2 args", () => {
    const ast = parseExpr("max(a, b)");
    expect(ast).toEqual({
      kind: "call",
      name: "max",
      args: [
        { kind: "variable", name: "a", isSymbolic: false },
        { kind: "variable", name: "b", isSymbolic: false },
      ],
    });
  });

  it("parses a // b as floor division", () => {
    const ast = parseExpr("a // b");
    expect(ast).toEqual({
      kind: "binary",
      op: "//",
      left: { kind: "variable", name: "a", isSymbolic: false },
      right: { kind: "variable", name: "b", isSymbolic: false },
    });
  });

  it("parses a % b as modulus", () => {
    const ast = parseExpr("a % b");
    expect(ast).toEqual({
      kind: "binary",
      op: "%",
      left: { kind: "variable", name: "a", isSymbolic: false },
      right: { kind: "variable", name: "b", isSymbolic: false },
    });
  });

  it("throws on empty expression", () => {
    expect(() => parseExpr("")).toThrow(ParseError);
  });

  it("throws on trailing operator (2 +)", () => {
    expect(() => parseExpr("2 +")).toThrow(ParseError);
  });

  it("throws on function call with trailing comma (floor(1,))", () => {
    expect(() => parseExpr("floor(1,)")).toThrow(ParseError);
  });

  it("throws on lone $", () => {
    expect(() => parseExpr("$")).toThrow(ParseError);
  });

  it("throws on mismatched parens", () => {
    expect(() => parseExpr("(a + b")).toThrow(ParseError);
  });

  it("throws on unexpected token after expression", () => {
    expect(() => parseExpr("a b")).toThrow(ParseError);
  });
});

// ── Evaluator Tests ─────────────────────────────────────────────────────────

describe("Expression Evaluator", () => {
  it("evaluates a number literal", () => {
    expect(evalStr("42")).toBe(42);
  });

  it("evaluates $H + 1 with env", () => {
    expect(evalStr("$H + 1", { env: { H: 32 } })).toBe(33);
  });

  it("evaluates 2 * padding + 1 with params", () => {
    expect(evalStr("2 * padding + 1", { params: { padding: "1" } })).toBe(3);
  });

  it("evaluates $* as product of const captured dims", () => {
    expect(evalStr("$*", { captured: [28, 28] })).toBe(784);
  });

  it("returns undefined for $* when captured dims are unresolved", () => {
    const compiled = compileExpression("$*", "dimension");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(evaluateCompiled(compiled.value)).toMatchObject({ kind: "deferred" });
  });

  it("returns undefined for unresolved $H", () => {
    expect(evalStr("$H", { env: {} })).toBeUndefined();
  });

  it("returns undefined for unknown bare identifier", () => {
    expect(evalStr("unknown_var", {})).toBeUndefined();
  });

  it("evaluates conv2d formula correctly", () => {
    // floor(($H + 2*padding - dilation*(kernel_size - 1) - 1)/stride + 1)
    // With H=32, padding=1, dilation=1, kernel_size=3, stride=1:
    // floor((32 + 2*1 - 1*(3-1) - 1)/1 + 1) = floor((32 + 2 - 2 - 1)/1 + 1) = 32
    const result = evalStr(
      "floor(($H + 2*padding - dilation*(kernel_size - 1) - 1)/stride + 1)",
      {
        env: { H: 32, W: 32 },
        params: {
          kernel_size: "3",
          stride: "1",
          padding: "1",
          dilation: "1",
        },
      },
    );
    expect(result).toBe(32);
  });

  it("evaluates pool2d formula correctly", () => {
    // floor(($H + 2*padding - kernel_size)/stride + 1)
    // With H=32, kernel_size=2, stride=2, padding=0:
    // floor((32 + 0 - 2)/2 + 1) = 16
    const result = evalStr("floor(($H + 2*padding - kernel_size)/stride + 1)", {
      env: { H: 32 },
      params: { kernel_size: "2", stride: "2", padding: "0" },
    });
    expect(result).toBe(16);
  });

  it("evaluates upsample formula correctly", () => {
    expect(evalStr("$H * scale_factor", {
      env: { H: 32 },
      params: { scale_factor: "2" },
    })).toBe(64);
  });

  it("evaluates abs(-5) = 5", () => {
    expect(evalStr("abs(-5)")).toBe(5);
  });

  it("evaluates max(3, 7) = 7", () => {
    expect(evalStr("max(3, 7)")).toBe(7);
  });

  it("evaluates min(10, 2) = 2", () => {
    expect(evalStr("min(10, 2)")).toBe(2);
  });

  it("evaluates ceil(3.2) = 4", () => {
    expect(evalStr("ceil(3.2)")).toBe(4);
  });

  it("evaluates floor(3.7) = 3", () => {
    expect(evalStr("floor(3.7)")).toBe(3);
  });

  it("evaluates integer floor division (//)", () => {
    expect(evalStr("7 // 2")).toBe(3);
  });

  it("evaluates modulus (%)", () => {
    expect(evalStr("7 % 3")).toBe(1);
  });

  it("evaluates unary minus", () => {
    expect(evalStr("-5")).toBe(-5);
  });

  it("evaluates -($H) with env", () => {
    expect(evalStr("-$H", { env: { H: 10 } })).toBe(-10);
  });

  it("evaluates nested binary ops with correct precedence", () => {
    expect(evalStr("2 + 3 * 4", {})).toBe(14); // 2 + (3*4) = 14, not (2+3)*4 = 20
  });

  it("evaluates groups with parens", () => {
    expect(evalStr("(2 + 3) * 4", {})).toBe(20);
  });

  it("evaluates conv2d with stride=2, padding=2, dilation=2", () => {
    // floor((32 + 2*2 - 2*(3-1) - 1)/2 + 1)
    // = floor((32 + 4 - 4 - 1)/2 + 1)
    // = floor(31/2 + 1) = floor(15.5 + 1) = floor(16.5) = 16
    const result = evalStr(
      "floor(($H + 2*padding - dilation*(kernel_size - 1) - 1)/stride + 1)",
      {
        env: { H: 32 },
        params: {
          kernel_size: "3",
          stride: "2",
          padding: "2",
          dilation: "2",
        },
      },
    );
    expect(result).toBe(16);
  });
});

// ── Integration: parse → evaluate round-trip ─────────────────────────────────

describe("Expression parse→evaluate round-trip", () => {
  it("handles complex nested expressions", () => {
    const src = "floor(($H + 2*padding - dilation*(kernel_size - 1) - 1)/stride + 1)";
    expect(evalStr(src, { env: { H: 32 }, params: { kernel_size: "3", stride: "1", padding: "1", dilation: "1" } })).toBe(32);
  });

  it("max with two parameters works", () => {
    expect(evalStr("max(stride, padding)", { params: { stride: "2", padding: "1" } })).toBe(2);
  });

  it("resolves declared parameter references", () => {
    expect(evalStr("kernel_size + 1", { params: { kernel_size: "3" } })).toBe(4);
  });
});
