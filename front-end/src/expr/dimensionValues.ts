/** Internal, non-serialized dimension terms. */
export type SymbolScope = "global" | "local";
export type DimensionValue = number | DimensionTerm;
export type DimensionOperation = "add" | "sub" | "mul" | "div" | "floor_div" | "mod" | "neg" | "floor" | "ceil" | "abs" | "min" | "max";
export type DimensionTerm =
  | { readonly tag: "symbol"; readonly name: string; readonly scope: SymbolScope }
  | { readonly tag: "op"; readonly op: DimensionOperation; readonly args: readonly DimensionValue[] };

const operations = new Set<DimensionOperation>(["add", "sub", "mul", "div", "floor_div", "mod", "neg", "floor", "ceil", "abs", "min", "max"]);

/** Raw `$H` expression references default to global scope. */
export const symbol = (name: string, scope: SymbolScope = "global"): DimensionTerm => ({ tag: "symbol", name, scope });

export function isTerm(value: unknown): value is DimensionTerm {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.tag === "symbol") return typeof candidate.name === "string" && (candidate.scope === "global" || candidate.scope === "local");
  return candidate.tag === "op" && typeof candidate.op === "string" && operations.has(candidate.op as DimensionOperation) && Array.isArray(candidate.args) && candidate.args.every(isDimensionValue);
}

export const isDimensionValue = (value: unknown): value is DimensionValue => typeof value === "number" || isTerm(value);

export function equalDimensions(left: DimensionValue, right: DimensionValue): boolean {
  if (typeof left === "number" || typeof right === "number") return left === right;
  if (left.tag !== right.tag) return false;
  if (left.tag === "symbol" || right.tag === "symbol") return left.tag === "symbol" && right.tag === "symbol" && left.name === right.name && left.scope === right.scope;
  return left.op === right.op && left.args.length === right.args.length && left.args.every((value, index) => equalDimensions(value, right.args[index]));
}

export function formatDimension(value: DimensionValue): string {
  if (typeof value === "number") return String(value);
  if (value.tag === "symbol") return value.scope === "global" ? `$${value.name}` : `#${value.name}`;
  switch (value.op) {
    case "neg": case "floor": case "ceil": case "abs": return `${value.op}(${formatDimension(value.args[0])})`;
    case "min": case "max": return `${value.op}(${value.args.map(formatDimension).join(", ")})`;
    default: return value.args.map(formatDimension).join(operatorSeparator(value.op));
  }
}

export function dimensionOperation(op: DimensionOperation, args: readonly DimensionValue[]): DimensionValue {
  if (!args.every((value) => typeof value === "number")) return { tag: "op", op, args };
  return evaluateConcrete(op, args as readonly number[]);
}

function operatorSeparator(op: Exclude<DimensionOperation, "neg" | "floor" | "ceil" | "abs" | "min" | "max">): string {
  switch (op) {
    case "add": return " + ";
    case "sub": return " - ";
    case "mul": return " * ";
    case "div": return " / ";
    case "floor_div": return " // ";
    case "mod": return " % ";
  }
}

function evaluateConcrete(op: DimensionOperation, values: readonly number[]): number {
  switch (op) {
    case "add": return values.reduce((left, right) => left + right, 0);
    case "sub": return values[0] - values[1];
    case "mul": return values.reduce((left, right) => left * right, 1);
    case "div": return values[0] / values[1];
    case "floor_div": return Math.floor(values[0] / values[1]);
    case "mod": return values[0] % values[1];
    case "neg": return -values[0];
    case "floor": return Math.floor(values[0]);
    case "ceil": return Math.ceil(values[0]);
    case "abs": return Math.abs(values[0]);
    case "min": return Math.min(...values);
    case "max": return Math.max(...values);
  }
}
