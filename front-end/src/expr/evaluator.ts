/**
 * @file Expression evaluator.
 *
 * Walks an ExprNode AST and evaluates it to a number.
 * Returns `undefined` when a variable cannot be resolved.
 */

import type { ExprNode, EvalContext } from "./types";

/**
 * Evaluate an expression AST to a numeric value.
 *
 * @param node - The AST node to evaluate.
 * @param context - Evaluation context with env, captured dims, and params.
 * @returns The numeric value, or `undefined` if a variable cannot be resolved.
 */
export function evaluate(
  node: ExprNode,
  context: EvalContext,
): number | undefined {
  switch (node.kind) {
    // ── Number literal ──────────────────────────────────────────
    case "number": {
      return node.value;
    }

    // ── Variable ────────────────────────────────────────────────
    case "variable": {
      if (node.isSymbolic) {
        // $NAME — resolve from symbolic environment
        const dim = context.env.get(node.name);
        if (!dim) return undefined;
        if (dim.kind === "const") return dim.value;
        return undefined;
      }
      // Bare identifier — resolve from params via resolveParam callback
      if (context.resolveParam) {
        return context.resolveParam(node.name);
      }
      // Fallback: try to read from params directly
      const raw = context.params[node.name];
      if (typeof raw === "number") return raw;
      if (typeof raw === "string") {
        const parsed = Number(raw);
        if (!isNaN(parsed)) return parsed;
      }
      return undefined;
    }

    // ── Wildcard product ($*) ───────────────────────────────────
    case "wildcard_product": {
      let product = 1;
      // eslint-disable-next-line prefer-const
      for (const dim of context.captured) {
        if (dim.kind === "const") {
          product *= dim.value;
        } else {
          // One captured dim is non-const → can't compute product
          return undefined;
        }
      }
      return product;
    }

    // ── Binary operator ─────────────────────────────────────────
    case "binary": {
      const left = evaluate(node.left, context);
      const right = evaluate(node.right, context);
      if (left === undefined || right === undefined) return undefined;

      switch (node.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          // Float division (like JS /)
          return left / right;
        case "//":
          // Integer floor division
          return Math.floor(left / right);
        case "%":
          return left % right;
        case "==": return left === right ? 1 : 0;
        case "!=": return left !== right ? 1 : 0;
        case ">": return left > right ? 1 : 0;
        case ">=": return left >= right ? 1 : 0;
        case "<": return left < right ? 1 : 0;
        case "<=": return left <= right ? 1 : 0;
        default:
          return undefined;
      }
    }

    // ── Unary operator ──────────────────────────────────────────
    case "unary": {
      const operand = evaluate(node.operand, context);
      if (operand === undefined) return undefined;
      return -operand;
    }

    // ── Function call ───────────────────────────────────────────
    case "call": {
      switch (node.name) {
        case "floor": {
          if (node.args.length !== 1) return undefined;
          const arg = evaluate(node.args[0], context);
          if (arg === undefined) return undefined;
          return Math.floor(arg);
        }
        case "ceil": {
          if (node.args.length !== 1) return undefined;
          const arg = evaluate(node.args[0], context);
          if (arg === undefined) return undefined;
          return Math.ceil(arg);
        }
        case "abs": {
          if (node.args.length !== 1) return undefined;
          const arg = evaluate(node.args[0], context);
          if (arg === undefined) return undefined;
          return Math.abs(arg);
        }
        case "max": {
          if (node.args.length !== 2) return undefined;
          const a = evaluate(node.args[0], context);
          const b = evaluate(node.args[1], context);
          if (a === undefined || b === undefined) return undefined;
          return Math.max(a, b);
        }
        case "min": {
          if (node.args.length !== 2) return undefined;
          const a = evaluate(node.args[0], context);
          const b = evaluate(node.args[1], context);
          if (a === undefined || b === undefined) return undefined;
          return Math.min(a, b);
        }
        default:
          return undefined;
      }
    }

    default:
      return undefined;
  }
}
