import type { ShapeDimension } from "../conversion/tensortypes";

export type TokenKind =
  | "NUMBER" | "STRING" | "IDENTIFIER" | "DOLLAR_IDENT" | "DOLLAR_STAR"
  | "PLUS" | "MINUS" | "STAR" | "SLASH" | "FLOOR_DIV" | "PERCENT"
  | "LPAREN" | "RPAREN" | "LBRACKET" | "RBRACKET" | "COMMA" | "EQUAL"
  | "ARROW" | "OP";

export interface Token { readonly kind: TokenKind; readonly value: string; readonly pos: number; }
export type BinaryOp = "+" | "-" | "*" | "/" | "//" | "%" | "==" | "!=" | ">" | ">=" | "<" | "<=" | "and" | "or";
export type ExprNode =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "variable"; readonly name: string; readonly isSymbolic: boolean }
  | { readonly kind: "wildcard_product" }
  | { readonly kind: "list"; readonly items: readonly ExprNode[] }
  | { readonly kind: "let"; readonly name: string; readonly value: ExprNode; readonly body: ExprNode }
  | { readonly kind: "lambda"; readonly parameter: string; readonly body: ExprNode }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: ExprNode; readonly right: ExprNode }
  | { readonly kind: "unary"; readonly op: "-" | "not"; readonly operand: ExprNode }
  | { readonly kind: "call"; readonly name: string; readonly args: readonly ExprNode[] };

export type ExpressionKind = "dimension" | "shape" | "constraint" | "dtype";
export type RuntimeValue = number | boolean | string | null | readonly RuntimeValue[] | TensorValue | LambdaValue;
export interface TensorValue { readonly shape: readonly number[]; readonly dtype: string; }
export interface LambdaValue { readonly parameter: string; readonly body: ExprNode; readonly scope: ReadonlyMap<string, RuntimeValue>; }
export type Evaluation =
  | { readonly kind: "value"; readonly value: RuntimeValue; readonly trace: readonly string[] }
  | { readonly kind: "deferred"; readonly trace: readonly string[] }
  | { readonly kind: "error"; readonly message: string; readonly trace: readonly string[] };
export interface CompiledExpression { readonly source: string; readonly expected: ExpressionKind; readonly ast: ExprNode; }
export interface ExpressionDiagnostic { readonly message: string; readonly start: number; readonly end: number; }
export interface EvalContext { env: Map<string, ShapeDimension>; captured: ShapeDimension[]; params: Record<string, unknown>; resolveParam?: (name: string) => number | undefined; }
export class ParseError extends Error { constructor(message: string, public readonly position: number) { super(message); this.name = "ParseError"; } }
