import { ParseError, type Token, type TokenKind } from "./types";

const SINGLE_TOKENS: Readonly<Record<string, TokenKind>> = { "+": "PLUS", "-": "MINUS", "*": "STAR", "/": "SLASH", "%": "PERCENT", "(": "LPAREN", ")": "RPAREN", "[": "LBRACKET", "]": "RBRACKET", ",": "COMMA", "=": "EQUAL" };

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const start = index;
    const character = source[index];
    if (/\s/.test(character)) { index++; continue; }
    if (source.startsWith("=>", index)) { tokens.push(token("ARROW", "=>", index)); index += 2; continue; }
    if (source.startsWith("//", index)) { tokens.push(token("FLOOR_DIV", "//", index)); index += 2; continue; }
    const comparison = ["==", "!=", ">=", "<="].find((operator) => source.startsWith(operator, index));
    if (comparison) { tokens.push(token("OP", comparison, index)); index += comparison.length; continue; }
    if (character === ">" || character === "<") { tokens.push(token("OP", character, index)); index++; continue; }
    if (SINGLE_TOKENS[character]) { tokens.push(token(SINGLE_TOKENS[character], character, index)); index++; continue; }
    if (character === "$") { index = readDollar(source, index, tokens); continue; }
    if (character === '"' || character === "'") { index = readString(source, index, tokens); continue; }
    if (/\d/.test(character)) { index = readNumber(source, index, tokens); continue; }
    if (/[A-Za-z_]/.test(character)) { index = readIdentifier(source, index, tokens); continue; }
    throw new ParseError(`Unexpected character '${character}'`, start);
  }
  return tokens;
}

function token(kind: TokenKind, value: string, pos: number): Token { return { kind, value, pos }; }
function readDollar(source: string, index: number, tokens: Token[]): number {
  if (source[index + 1] === "*") { tokens.push(token("DOLLAR_STAR", "$*", index)); return index + 2; }
  if (!/[A-Za-z_]/.test(source[index + 1] ?? "")) throw new ParseError("Unexpected '$'", index);
  const start = index++;
  while (/[A-Za-z0-9_]/.test(source[index] ?? "")) index++;
  tokens.push(token("DOLLAR_IDENT", source.slice(start + 1, index), start));
  return index;
}
function readString(source: string, index: number, tokens: Token[]): number {
  const start = index; const quote = source[index++]; let value = "";
  while (index < source.length && source[index] !== quote) { if (source[index] === "\\" && index + 1 < source.length) index++; value += source[index++]; }
  if (source[index] !== quote) throw new ParseError("Unterminated string", start);
  tokens.push(token("STRING", value, start)); return index + 1;
}
function readNumber(source: string, index: number, tokens: Token[]): number {
  const start = index; while (/\d/.test(source[index] ?? "")) index++;
  if (source[index] === ".") { index++; while (/\d/.test(source[index] ?? "")) index++; }
  tokens.push(token("NUMBER", source.slice(start, index), start)); return index;
}
function readIdentifier(source: string, index: number, tokens: Token[]): number {
  const start = index; while (/[A-Za-z0-9_.]/.test(source[index] ?? "")) index++;
  tokens.push(token("IDENTIFIER", source.slice(start, index), start)); return index;
}
