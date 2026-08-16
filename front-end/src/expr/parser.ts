import { ParseError, type BinaryOp, type ExprNode, type Token, type TokenKind } from "./types";

export function parse(tokens: readonly Token[]): ExprNode {
  return new Parser(tokens).parse();
}

class Parser {
  private position = 0;
  constructor(private readonly tokens: readonly Token[]) {}

  parse(): ExprNode {
    if (!this.tokens.length) throw new ParseError("Empty expression", 0);
    const expression = this.parseExpression();
    if (this.peek()) throw new ParseError(`Unexpected token '${this.peek()!.value}' after expression`, this.peek()!.pos);
    return expression;
  }
  private parseExpression(): ExprNode {
    if (this.matchesWord("let")) return this.parseLet();
    if (this.peek()?.kind === "IDENTIFIER" && this.tokens[this.position + 1]?.kind === "ARROW") return this.parseLambda();
    return this.parseLogical();
  }
  private parseLet(): ExprNode {
    this.take(); const name = this.take("IDENTIFIER").value; this.take("EQUAL");
    const value = this.parseExpression();
    if (!this.matchesWord("in")) throw new ParseError("Expected 'in'", this.peek()?.pos ?? this.endPosition());
    this.take(); return { kind: "let", name, value, body: this.parseExpression() };
  }
  private parseLambda(): ExprNode {
    const parameter = this.take("IDENTIFIER").value; this.take("ARROW");
    return { kind: "lambda", parameter, body: this.parseExpression() };
  }
  private parseLogical(): ExprNode { return this.parseLeftAssociative(() => this.parseComparison(), ["and", "or"]); }
  private parseComparison(): ExprNode {
    let left = this.parseAdditive();
    if (this.peek()?.kind === "OP") { const operator = this.take().value as BinaryOp; left = { kind: "binary", op: operator, left, right: this.parseAdditive() }; }
    return left;
  }
  private parseAdditive(): ExprNode { return this.parseLeftAssociative(() => this.parseMultiplicative(), ["+", "-"]); }
  private parseMultiplicative(): ExprNode { return this.parseLeftAssociative(() => this.parseUnary(), ["*", "/", "//", "%"]); }
  private parseLeftAssociative(parseOperand: () => ExprNode, operators: readonly string[]): ExprNode {
    let left = parseOperand();
    while (this.peek() && operators.includes(this.peek()!.value)) { const op = this.take().value as BinaryOp; left = { kind: "binary", op, left, right: parseOperand() }; }
    return left;
  }
  private parseUnary(): ExprNode {
    if (this.peek()?.kind === "MINUS") { this.take(); return { kind: "unary", op: "-", operand: this.parseUnary() }; }
    if (this.matchesWord("not")) { this.take(); return { kind: "unary", op: "not", operand: this.parseUnary() }; }
    return this.parsePrimary();
  }
  private parsePrimary(): ExprNode {
    const current = this.take();
    if (current.kind === "NUMBER") return { kind: "number", value: Number(current.value) };
    if (current.kind === "STRING") return { kind: "string", value: current.value };
    if (current.kind === "DOLLAR_IDENT") return { kind: "variable", name: current.value, isSymbolic: true };
    if (current.kind === "DOLLAR_STAR") return { kind: "wildcard_product" };
    if (current.kind === "LBRACKET") return this.parseList();
    if (current.kind === "LPAREN") { const expression = this.parseExpression(); this.take("RPAREN"); return expression; }
    if (current.kind === "IDENTIFIER") return this.parseIdentifier(current.value);
    throw new ParseError(`Unexpected token '${current.value}'`, current.pos);
  }
  private parseList(): ExprNode {
    const items: ExprNode[] = [];
    if (this.peek()?.kind !== "RBRACKET") { items.push(this.parseExpression()); while (this.peek()?.kind === "COMMA") { this.take(); items.push(this.parseExpression()); } }
    this.take("RBRACKET"); return { kind: "list", items };
  }
  private parseIdentifier(name: string): ExprNode {
    if (name === "true" || name === "false") return { kind: "boolean", value: name === "true" };
    if (this.peek()?.kind !== "LPAREN") return { kind: "variable", name, isSymbolic: false };
    this.take(); const args: ExprNode[] = [];
    if (this.peek()?.kind !== "RPAREN") { args.push(this.parseExpression()); while (this.peek()?.kind === "COMMA") { this.take(); args.push(this.parseExpression()); } }
    this.take("RPAREN"); return { kind: "call", name, args };
  }
  private matchesWord(word: string): boolean { const token = this.peek(); return token?.kind === "IDENTIFIER" && token.value === word; }
  private peek(): Token | undefined { return this.tokens[this.position]; }
  private take(kind?: TokenKind): Token { const token = this.peek(); if (!token) throw new ParseError(`Unexpected end of expression${kind ? `, expected ${kind}` : ""}`, this.endPosition()); if (kind && token.kind !== kind) throw new ParseError(`Expected ${kind}, got '${token.value}'`, token.pos); this.position++; return token; }
  private endPosition(): number { const last = this.tokens.at(-1); return last ? last.pos + last.value.length : 0; }
}
