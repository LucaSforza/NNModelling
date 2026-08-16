/**
 * @file Public API for the expression evaluator module.
 *
 * Provides:
 *   - parseExpr(source) — parse an expression string into an AST
 *   - evaluate(node, context) — evaluate an AST to a number
 *   - ParseError — thrown on syntax errors
 */

import { tokenize } from "./tokenizer";
import { parse } from "./parser";
import { evaluate } from "./evaluator";
import { ParseError } from "./types";

export type { ExprNode, EvalContext, BinaryOp, Token, TokenKind } from "./types";
export type { CompiledExpression, Evaluation, ExpressionKind, ExpressionDiagnostic, RuntimeValue, TensorValue } from "./types";
export { ParseError };

// ── Parsing with cache ──────────────────────────────────────────────────────

const parseCache = new Map<string, ReturnType<typeof parse>>();

/**
 * Parse an expression string into an AST.
 * Results are cached to avoid re-parsing the same expression.
 *
 * @param source - The expression string (e.g. "floor(($H + 2*padding) / stride + 1)")
 * @returns The parsed AST.
 * @throws {ParseError} on syntax errors.
 */
export function parseExpr(source: string): ReturnType<typeof parse> {
  const cached = parseCache.get(source);
  if (cached) return cached;
  const tokens = tokenize(source);
  const ast = parse(tokens);
  parseCache.set(source, ast);
  return ast;
}

export { evaluate };
export { compileExpression, evaluateCompiled } from "./typed";
export type { TypedEvalContext } from "./typed";
