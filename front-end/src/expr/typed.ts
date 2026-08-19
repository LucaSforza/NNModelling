import { parseExpr } from "./index";
import type {
  CompiledExpression,
  Evaluation,
  ExpressionDiagnostic,
  ExpressionKind,
  ExprNode,
  LambdaValue,
  RuntimeValue,
  TensorValue,
} from "./types";
import { dimensionOperation, equalDimensions, isDimensionValue, symbol, type DimensionValue } from "./dimensionValues";

type ValueKind = "number" | "boolean" | "string" | "shape" | "dtype" | "tensor" | "list" | "lambda" | "any";
type CompileResult = { ok: true; value: CompiledExpression } | { ok: false; error: ExpressionDiagnostic };
type CallNode = Extract<ExprNode, { kind: "call" }>;

interface OperatorSignature {
  readonly min: number;
  readonly max: number;
  readonly args: readonly ValueKind[];
  readonly result: ValueKind;
}

/** Names made available by the enclosing signature at schema-load time. */
export interface CompileOptions {
  readonly parameterNames?: Iterable<string>;
  readonly symbols?: Iterable<string>;
}

export interface TypedEvalContext {
  readonly params?: Record<string, unknown>;
  readonly inputs?: readonly (readonly TensorValue[])[] | readonly TensorValue[];
  readonly symbols?: ReadonlyMap<string, DimensionValue> | Readonly<Record<string, DimensionValue>>;
  readonly capturedDimensions?: readonly DimensionValue[];
  readonly applySubflow?: (tensor: TensorValue, trace: readonly string[]) => Evaluation;
  readonly trace?: readonly string[];
  readonly maxIterations?: number;
  readonly maxDepth?: number;
}

const cache = new Map<string, CompiledExpression>();
const expectedKinds: Record<ExpressionKind, ValueKind> = {
  dimension: "number",
  shape: "shape",
  constraint: "boolean",
  dtype: "dtype",
};

const operators: Record<string, OperatorSignature> = {
  input: { min: 1, max: 2, args: ["number", "number"], result: "tensor" },
  inputs: { min: 1, max: 1, args: ["number"], result: "list" },
  shape: { min: 1, max: 1, args: ["tensor"], result: "shape" },
  dtype: { min: 1, max: 1, args: ["tensor"], result: "dtype" },
  rank: { min: 1, max: 1, args: ["tensor"], result: "number" },
  dim: { min: 2, max: 2, args: ["tensor", "number"], result: "number" },
  axis: { min: 2, max: 2, args: ["number", "number"], result: "number" },
  floor: { min: 1, max: 1, args: ["number"], result: "number" },
  ceil: { min: 1, max: 1, args: ["number"], result: "number" },
  abs: { min: 1, max: 1, args: ["number"], result: "number" },
  min: { min: 1, max: Number.MAX_SAFE_INTEGER, args: ["number"], result: "number" },
  max: { min: 1, max: Number.MAX_SAFE_INTEGER, args: ["number"], result: "number" },
  item: { min: 2, max: 2, args: ["any", "number"], result: "number" },
  product: { min: 1, max: 1, args: ["any"], result: "number" },
  as_list: { min: 1, max: 1, args: ["any"], result: "shape" },
  length: { min: 1, max: 1, args: ["list"], result: "number" },
  sum: { min: 1, max: 1, args: ["list"], result: "number" },
  slice: { min: 2, max: 3, args: ["shape", "number", "number"], result: "shape" },
  remove: { min: 2, max: 2, args: ["shape", "number"], result: "shape" },
  replace: { min: 3, max: 3, args: ["shape", "number", "number"], result: "shape" },
  splice: { min: 3, max: 3, args: ["shape", "number", "shape"], result: "shape" },
  map: { min: 2, max: 2, args: ["list", "lambda"], result: "list" },
  all: { min: 1, max: 2, args: ["list", "lambda"], result: "boolean" },
  all_equal: { min: 1, max: 1, args: ["list"], result: "boolean" },
  allEqual: { min: 1, max: 1, args: ["list"], result: "boolean" },
  if: { min: 3, max: 3, args: ["boolean", "any", "any"], result: "any" },
  coalesce: { min: 1, max: Number.MAX_SAFE_INTEGER, args: ["any"], result: "any" },
  is_integer: { min: 1, max: 1, args: ["number"], result: "boolean" },
  between: { min: 3, max: 3, args: ["number", "number", "number"], result: "boolean" },
  apply: { min: 1, max: 1, args: ["tensor"], result: "tensor" },
  iterate: { min: 3, max: 3, args: ["number", "tensor", "lambda"], result: "tensor" },
};

const lazyOperators = new Set(["if", "coalesce", "map", "all", "iterate"]);

export function compileExpression(source: string, expected: ExpressionKind, options: CompileOptions = {}): CompileResult {
  try {
    const ast = parseExpr(source);
    const result = infer(ast, options, new Map());
    if (result !== "any" && result !== expectedKinds[expected]) {
      return fail(`expected ${expected}, got ${result}`, 0, source.length);
    }
    const key = `${expected}\0${source}`;
    const value = cache.get(key) ?? { source, expected, ast };
    cache.set(key, value);
    return { ok: true, value };
  } catch (error) {
    const position = error instanceof Error && "position" in error ? Number(error.position) : 0;
    return fail(error instanceof Error ? error.message : "invalid expression", position, Math.max(position + 1, source.length));
  }
}

export function evaluateCompiled(expression: CompiledExpression, context: TypedEvalContext = {}): Evaluation {
  return evaluateNode(expression.ast, context, new Map(), 0);
}

function fail(message: string, start: number, end: number): CompileResult {
  return { ok: false, error: { message, start, end } };
}

function infer(node: ExprNode, options: CompileOptions, bound: ReadonlyMap<string, ValueKind>): ValueKind {
  switch (node.kind) {
    case "number": case "wildcard_product": return "number";
    case "string": return "string";
    case "boolean": return "boolean";
    case "list": return inferList(node.items, options, bound);
    case "variable": return inferVariable(node, options, bound);
    case "let": return inferLet(node, options, bound);
    case "lambda": return inferLambda(node, options, bound);
    case "unary": return inferUnary(node, options, bound);
    case "binary": return inferBinary(node, options, bound);
    case "call": return inferCall(node, options, bound);
  }
}

function inferList(items: readonly ExprNode[], options: CompileOptions, bound: ReadonlyMap<string, ValueKind>): ValueKind {
  const itemKinds = items.map((item) => infer(item, options, bound));
  return itemKinds.every((kind) => kind === "number" || kind === "any") ? "shape" : "list";
}

function inferVariable(node: Extract<ExprNode, { kind: "variable" }>, options: CompileOptions, bound: ReadonlyMap<string, ValueKind>): ValueKind {
  if (node.isSymbolic) {
    if (options.symbols && !new Set(options.symbols).has(node.name)) throw new Error(`unknown symbol '$${node.name}'`);
    return "number";
  }
  const boundKind = bound.get(node.name);
  if (boundKind) return boundKind;
  if (node.name.startsWith("param.")) {
    const name = node.name.slice(6);
    if (!name) throw new Error("parameter reference requires a name");
    if (options.parameterNames && !new Set(options.parameterNames).has(name)) throw new Error(`unknown parameter '${name}'`);
    return "any";
  }
  if (["float16", "float32", "float64", "int32", "int64", "bool"].includes(node.name)) return "dtype";
  if (options.parameterNames && new Set(options.parameterNames).has(node.name)) return "any";
  throw new Error(`unknown reference '${node.name}'`);
}

function inferLet(node: Extract<ExprNode, { kind: "let" }>, options: CompileOptions, bound: ReadonlyMap<string, ValueKind>): ValueKind {
  return infer(node.body, options, bind(bound, node.name, infer(node.value, options, bound)));
}

function inferLambda(node: Extract<ExprNode, { kind: "lambda" }>, options: CompileOptions, bound: ReadonlyMap<string, ValueKind>): ValueKind {
  infer(node.body, options, bind(bound, node.parameter, "any"));
  return "lambda";
}

function inferUnary(node: Extract<ExprNode, { kind: "unary" }>, options: CompileOptions, bound: ReadonlyMap<string, ValueKind>): ValueKind {
  const kind = infer(node.operand, options, bound);
  if (node.op === "not") {
    requireKind("boolean", kind, "not requires boolean");
    return "boolean";
  }
  requireKind("number", kind, "unary - requires number");
  return "number";
}

function inferBinary(node: Extract<ExprNode, { kind: "binary" }>, options: CompileOptions, bound: ReadonlyMap<string, ValueKind>): ValueKind {
  const left = infer(node.left, options, bound);
  const right = infer(node.right, options, bound);
  if (node.op === "and" || node.op === "or") {
    requireKind("boolean", left, `${node.op} requires booleans`);
    requireKind("boolean", right, `${node.op} requires booleans`);
    return "boolean";
  }
  if (node.op === "==" || node.op === "!=") return "boolean";
  if (isComparisonOperator(node.op)) {
    requireKind("number", left, "comparison requires numbers");
    requireKind("number", right, "comparison requires numbers");
    return "boolean";
  }
  requireKind("number", left, "arithmetic requires numbers");
  requireKind("number", right, "arithmetic requires numbers");
  return "number";
}

function inferCall(node: CallNode, options: CompileOptions, bound: ReadonlyMap<string, ValueKind>): ValueKind {
  const operator = operators[node.name];
  if (!operator) throw new Error(`unknown operator '${node.name}'`);
  if (node.args.length < operator.min || node.args.length > operator.max) {
    const expected = operator.min === operator.max ? operator.min : `${operator.min}..${operator.max}`;
    throw new Error(`operator '${node.name}' expects ${expected} arguments`);
  }
  const argumentKinds = node.args.map((arg, index) => {
    const actual = infer(arg, options, bound);
    const expected = operator.args[Math.min(index, operator.args.length - 1)] ?? "any";
    if (!acceptsKind(expected, actual)) throw new Error(`operator '${node.name}' argument ${index + 1} expects ${expected}, got ${actual}`);
    return actual;
  });
  if (node.name === "if") return unifyKinds(argumentKinds[1], argumentKinds[2]);
  if (node.name === "coalesce") return argumentKinds.reduce(unifyKinds);
  if (node.name === "product" && !["number", "shape", "list", "any"].includes(argumentKinds[0])) throw new Error("product requires a dimension or list");
  return operator.result;
}

function unifyKinds(left: ValueKind, right: ValueKind): ValueKind {
  if (left === right) return left;
  if (left === "any") return right;
  if (right === "any") return left;
  throw new Error(`incompatible result kinds: ${left} and ${right}`);
}

function requireKind(expected: ValueKind, actual: ValueKind, message: string): void {
  if (!acceptsKind(expected, actual)) throw new Error(message);
}

function acceptsKind(expected: ValueKind, actual: ValueKind): boolean {
  return expected === "any" || actual === "any" || expected === actual || (expected === "list" && actual === "shape");
}

const ok = (value: RuntimeValue, trace: readonly string[] = []): Evaluation => ({ kind: "value", value, trace });
const defer = (trace: readonly string[] = []): Evaluation => ({ kind: "deferred", trace });
const err = (message: string, trace: readonly string[] = []): Evaluation => ({ kind: "error", message, trace });

function evaluateNode(node: ExprNode, context: TypedEvalContext, scope: ReadonlyMap<string, RuntimeValue>, depth: number): Evaluation {
  const trace = context.trace ?? [];
  if (depth > (context.maxDepth ?? 64)) return err("expression recursion limit exceeded", trace);
  switch (node.kind) {
    case "number": case "string": case "boolean": return ok(node.value, trace);
    case "wildcard_product": return evaluateWildcardProduct(context, trace);
    case "list": return evaluateList(node.items, context, scope, depth, trace);
    case "variable": return evaluateVariable(node, context, scope, trace);
    case "let": return evaluateLet(node, context, scope, depth);
    case "lambda": return ok({ parameter: node.parameter, body: node.body, scope: new Map(scope) }, trace);
    case "unary": return evaluateUnary(node, context, scope, depth, trace);
    case "binary": return evaluateBinary(node, context, scope, depth, trace);
    case "call": return call(node, context, scope, depth);
  }
}

function evaluateList(items: readonly ExprNode[], context: TypedEvalContext, scope: ReadonlyMap<string, RuntimeValue>, depth: number, trace: readonly string[]): Evaluation {
  const values: RuntimeValue[] = [];
  for (const item of items) {
    const result = evaluateNode(item, context, scope, depth + 1);
    if (result.kind !== "value") return result;
    values.push(result.value);
  }
  return ok(values, trace);
}

function evaluateVariable(node: Extract<ExprNode, { kind: "variable" }>, context: TypedEvalContext, scope: ReadonlyMap<string, RuntimeValue>, trace: readonly string[]): Evaluation {
  if (scope.has(node.name)) return ok(scope.get(node.name)!, trace);
  if (node.isSymbolic) {
    const value = lookupSymbol(context.symbols, node.name);
    return ok(value ?? symbol(node.name), trace);
  }
  if (["float16", "float32", "float64", "int32", "int64", "bool"].includes(node.name)) return ok(node.name, trace);
  const name = node.name.startsWith("param.") ? node.name.slice(6) : node.name;
  const value = context.params?.[name];
  return value === undefined ? defer(trace) : ok(normalize(value), trace);
}

function evaluateLet(node: Extract<ExprNode, { kind: "let" }>, context: TypedEvalContext, scope: ReadonlyMap<string, RuntimeValue>, depth: number): Evaluation {
  const value = evaluateNode(node.value, context, scope, depth + 1);
  if (value.kind !== "value") return value;
  return evaluateNode(node.body, context, bind(scope, node.name, value.value), depth + 1);
}

function evaluateUnary(node: Extract<ExprNode, { kind: "unary" }>, context: TypedEvalContext, scope: ReadonlyMap<string, RuntimeValue>, depth: number, trace: readonly string[]): Evaluation {
  const result = evaluateNode(node.operand, context, scope, depth + 1);
  if (result.kind !== "value") return result;
  if (node.op === "not") return typeof result.value === "boolean" ? ok(!result.value, trace) : err("not requires boolean", trace);
  return isDimensionValue(result.value) ? ok(dimensionOperation("neg", [result.value]), trace) : err("unary - requires number", trace);
}

function evaluateBinary(node: Extract<ExprNode, { kind: "binary" }>, context: TypedEvalContext, scope: ReadonlyMap<string, RuntimeValue>, depth: number, trace: readonly string[]): Evaluation {
  const left = evaluateNode(node.left, context, scope, depth + 1);
  if (left.kind !== "value") return left;
  if (node.op === "and" && left.value === false) return ok(false, trace);
  if (node.op === "or" && left.value === true) return ok(true, trace);
  const right = evaluateNode(node.right, context, scope, depth + 1);
  if (right.kind !== "value") return right;
  if (node.op === "and" || node.op === "or") return evaluateBooleanBinary(node.op, left.value, right.value, trace);
  if (node.op === "==" || node.op === "!=") return ok(node.op === "==" ? same(left.value, right.value) : !same(left.value, right.value), trace);
  if (isComparisonOperator(node.op)) return evaluateComparison(node.op, left.value, right.value, trace);
  return evaluateArithmetic(node.op, left.value, right.value, trace);
}

function evaluateBooleanBinary(op: "and" | "or", left: RuntimeValue, right: RuntimeValue, trace: readonly string[]): Evaluation {
  if (typeof left !== "boolean" || typeof right !== "boolean") return err(`${op} requires booleans`, trace);
  return ok(op === "and" ? left && right : left || right, trace);
}

function evaluateComparison(op: ">" | ">=" | "<" | "<=", left: RuntimeValue, right: RuntimeValue, trace: readonly string[]): Evaluation {
  if (!isDimensionValue(left) || !isDimensionValue(right)) return err("comparison requires numbers", trace);
  if (typeof left !== "number" || typeof right !== "number") return defer(trace);
  return ok(op === ">" ? left > right : op === ">=" ? left >= right : op === "<" ? left < right : left <= right, trace);
}

function evaluateArithmetic(op: string, left: RuntimeValue, right: RuntimeValue, trace: readonly string[]): Evaluation {
  if (!isDimensionValue(left) || !isDimensionValue(right)) return err("arithmetic requires numbers", trace);
  return ok(arithmetic(op, left, right), trace);
}

function call(node: CallNode, context: TypedEvalContext, scope: ReadonlyMap<string, RuntimeValue>, depth: number): Evaluation {
  const trace = context.trace ?? [];
  if (lazyOperators.has(node.name)) return callLazy(node, context, scope, depth, trace);
  const results = node.args.map((arg) => evaluateNode(arg, context, scope, depth + 1));
  const bad = results.find((result) => result.kind !== "value");
  if (bad) return bad;
  return callEager(node.name, results.map((result) => (result as Extract<Evaluation, { kind: "value" }>).value), context, scope, depth, trace);
}

function callLazy(node: CallNode, context: TypedEvalContext, scope: ReadonlyMap<string, RuntimeValue>, depth: number, trace: readonly string[]): Evaluation {
  switch (node.name) {
    case "if": return callIf(node, context, scope, depth, trace);
    case "coalesce": return callCoalesce(node, context, scope, depth, trace);
    case "map": case "all": return callCollection(node, context, scope, depth, trace);
    case "iterate": return callIterate(node, context, scope, depth, trace);
    default: return err(`invalid arguments for '${node.name}'`, trace);
  }
}

function callIf(node: CallNode, context: TypedEvalContext, scope: ReadonlyMap<string, RuntimeValue>, depth: number, trace: readonly string[]): Evaluation {
  const test = evaluateNode(node.args[0], context, scope, depth + 1);
  if (test.kind !== "value") return test;
  if (typeof test.value !== "boolean") return err("if requires boolean", trace);
  return evaluateNode(node.args[test.value ? 1 : 2], context, scope, depth + 1);
}

function callCoalesce(node: CallNode, context: TypedEvalContext, scope: ReadonlyMap<string, RuntimeValue>, depth: number, trace: readonly string[]): Evaluation {
  for (const argument of node.args) {
    const result = evaluateNode(argument, context, scope, depth + 1);
    if (result.kind === "error") return result;
    if (result.kind === "value" && result.value !== null) return result;
  }
  return defer(trace);
}

function callCollection(node: CallNode, context: TypedEvalContext, scope: ReadonlyMap<string, RuntimeValue>, depth: number, trace: readonly string[]): Evaluation {
  const operation: "map" | "all" = node.name === "map" ? "map" : "all";
  const collection = evaluateNode(node.args[0], context, scope, depth + 1);
  if (collection.kind !== "value") return collection;
  if (!list(collection.value)) return err(`${operation} requires a list`, trace);
  const lambda = evaluateLambda(node.args[1], operation, context, scope, depth);
  if (lambda instanceof Object && "kind" in lambda) return lambda;
  const values: RuntimeValue[] = [];
  for (const item of collection.value) {
    if (!lambda) {
      if (typeof item !== "boolean") return err("all requires booleans", trace);
      values.push(item);
      continue;
    }
    const result = invoke(lambda, item, context, depth + 1);
    if (result.kind !== "value") return result;
    values.push(result.value);
  }
  return operation === "map" ? ok(values, trace) : ok(values.every((value) => value === true), trace);
}

function evaluateLambda(node: ExprNode | undefined, operation: "map" | "all", context: TypedEvalContext, scope: ReadonlyMap<string, RuntimeValue>, depth: number): LambdaValue | undefined | Evaluation {
  if (!node) return undefined;
  const result = evaluateNode(node, context, scope, depth + 1);
  if (result.kind !== "value") return result;
  return lambdaValue(result.value) ? result.value : err(`${operation} requires a lambda`, context.trace ?? []);
}

function callIterate(node: CallNode, context: TypedEvalContext, scope: ReadonlyMap<string, RuntimeValue>, depth: number, trace: readonly string[]): Evaluation {
  const count = evaluateNode(node.args[0], context, scope, depth + 1);
  const initial = evaluateNode(node.args[1], context, scope, depth + 1);
  const lambda = evaluateNode(node.args[2], context, scope, depth + 1);
  if (count.kind !== "value" || initial.kind !== "value" || lambda.kind !== "value") {
    return count.kind !== "value" ? count : initial.kind !== "value" ? initial : lambda;
  }
  if (typeof count.value !== "number" || !Number.isInteger(count.value) || count.value < 0) return err("iterate count must be a non-negative integer", trace);
  if (count.value > (context.maxIterations ?? 128)) return err("iterate limit exceeded", trace);
  if (!lambdaValue(lambda.value)) return err("iterate requires a lambda", trace);
  let state = initial.value;
  for (let index = 0; index < count.value; index += 1) {
    const result = invoke(lambda.value, state, { ...context, trace: [...trace, `iteration=${index + 1}`] }, depth + 1);
    if (result.kind !== "value") return result;
    state = result.value;
  }
  return ok(state, trace);
}

function callEager(name: string, values: readonly RuntimeValue[], context: TypedEvalContext, scope: ReadonlyMap<string, RuntimeValue>, depth: number, trace: readonly string[]): Evaluation {
  if (name === "input" || name === "inputs") return callInput(name, values, context, trace);
  const tensorResult = callTensorProjection(name, values, trace);
  if (tensorResult) return tensorResult;
  const shapeResult = callShapeOperation(name, values, trace);
  if (shapeResult) return shapeResult;
  const numericResult = callNumericOperation(name, values, trace);
  if (numericResult) return numericResult;
  if (name === "as_list") return asList(values[0], trace);
  if (name === "length") return list(values[0]) ? ok(values[0].length, trace) : err("length requires a list", trace);
  if (name === "item") return item(values[0], values[1], trace);
  if ((name === "all_equal" || name === "allEqual") && list(values[0])) {
    const collection = values[0];
    return ok(collection.every((value) => same(value, collection[0])), trace);
  }
  if (name === "apply" && tensor(values[0])) return context.applySubflow ? context.applySubflow(values[0], [...trace, "apply"]) : defer(trace);
  return err(`invalid arguments for '${name}'`, trace);
}

function asList(value: RuntimeValue, trace: readonly string[]): Evaluation {
  if (isDimensionValue(value)) return ok([value], trace);
  if (list(value) && value.every(isDimensionValue)) return ok(value, trace);
  return err("as_list requires a dimension or list", trace);
}

function item(value: RuntimeValue, index: RuntimeValue, trace: readonly string[]): Evaluation {
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return err("item index must be a non-negative integer", trace);
  if (isDimensionValue(value)) return ok(value, trace);
  if (!list(value)) return err("item requires a dimension or list", trace);
  if (index >= value.length) return err("item index out of range", trace);
  return isDimensionValue(value[index]) ? ok(value[index], trace) : err("item list must contain dimensions", trace);
}

function callInput(name: "input" | "inputs", values: readonly RuntimeValue[], context: TypedEvalContext, trace: readonly string[]): Evaluation {
  const groups = normalizeInputs(context.inputs);
  if (name === "inputs") return typeof values[0] === "number" ? groups[values[0]] ? ok(groups[values[0]], trace) : defer(trace) : err("inputs requires group", trace);
  const group = values.length === 1 ? 0 : values[0];
  const index = values.length === 1 ? values[0] : values[1];
  return typeof group === "number" && typeof index === "number" ? groups[group]?.[index] ? ok(groups[group][index], trace) : defer(trace) : err("input requires index or group and index", trace);
}

function callTensorProjection(name: string, values: readonly RuntimeValue[], trace: readonly string[]): Evaluation | undefined {
  const tensorValue = values[0];
  if (name === "shape" && tensor(tensorValue)) return ok(tensorValue.shape, trace);
  if (name === "dtype" && tensor(tensorValue)) return ok(tensorValue.dtype, trace);
  if (name === "rank" && tensor(tensorValue)) return ok(tensorValue.shape.length, trace);
  if (name === "dim" && tensor(tensorValue) && typeof values[1] === "number") return at(tensorValue.shape, values[1], trace);
  if (name === "axis" && typeof values[0] === "number" && typeof values[1] === "number") return normalizeAxis(values[0], values[1], trace);
  return undefined;
}

function callShapeOperation(name: string, values: readonly RuntimeValue[], trace: readonly string[]): Evaluation | undefined {
  if (!list(values[0]) || typeof values[1] !== "number") return undefined;
  const shape = values[0];
  if (name === "slice") return ok(shape.slice(values[1], typeof values[2] === "number" ? values[2] : undefined), trace);
  const position = index(values[1], shape.length, name === "splice");
  if (name !== "remove" && name !== "replace" && name !== "splice") return undefined;
  if (position === undefined) return err("axis out of range", trace);
  if (name === "remove") return ok(shape.filter((_, index) => index !== position), trace);
  if (name === "replace" && isDimensionValue(values[2])) return ok(shape.map((value, index) => index === position ? values[2] : value), trace);
  return list(values[2]) ? ok([...shape.slice(0, position), ...values[2], ...shape.slice(position)], trace) : undefined;
}

function callNumericOperation(name: string, values: readonly RuntimeValue[], trace: readonly string[]): Evaluation | undefined {
  if (name === "product" && isDimensionValue(values[0])) return ok(values[0], trace);
  if ((name === "sum" || name === "product") && list(values[0]) && values[0].every(isDimensionValue)) {
    return ok(dimensionOperation(name === "sum" ? "add" : "mul", values[0] as readonly DimensionValue[]), trace);
  }
  if (["floor", "ceil", "abs", "min", "max"].includes(name) && values.every(isDimensionValue)) {
    return ok(dimensionOperation(name as "floor" | "ceil" | "abs" | "min" | "max", values as readonly DimensionValue[]), trace);
  }
  if (name === "is_integer" && typeof values[0] === "number") return ok(Number.isInteger(values[0]), trace);
  if (name === "between" && values.every((value) => typeof value === "number")) return ok((values[0] as number) >= (values[1] as number) && (values[0] as number) <= (values[2] as number), trace);
  return undefined;
}

function invoke(lambda: LambdaValue, value: RuntimeValue, context: TypedEvalContext, depth: number): Evaluation {
  return evaluateNode(lambda.body, context, bind(lambda.scope, lambda.parameter, value), depth + 1);
}

function bind<K, V>(scope: ReadonlyMap<K, V>, key: K, value: V): Map<K, V> {
  const result = new Map(scope);
  result.set(key, value);
  return result;
}

function evaluateWildcardProduct(context: TypedEvalContext, trace: readonly string[]): Evaluation {
  const dimensions = context.capturedDimensions;
  return dimensions ? ok(dimensionOperation("mul", dimensions), trace) : defer(trace);
}

function lookupSymbol(symbols: TypedEvalContext["symbols"], name: string): DimensionValue | undefined {
  if (!symbols) return undefined;
  return isSymbolMap(symbols) ? symbols.get(name) : symbols[name];
}

function isSymbolMap(symbols: NonNullable<TypedEvalContext["symbols"]>): symbols is ReadonlyMap<string, DimensionValue> {
  return "get" in symbols && typeof symbols.get === "function";
}

function normalize(value: unknown): RuntimeValue {
  if (Array.isArray(value)) return value.map(normalize);
  return value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string" ? value : String(value);
}

function normalizeInputs(inputs: TypedEvalContext["inputs"]): readonly (readonly TensorValue[])[] {
  if (!inputs) return [];
  return inputs.length && tensor((inputs as readonly unknown[])[0]) ? [inputs as readonly TensorValue[]] : inputs as readonly (readonly TensorValue[])[];
}

function tensor(value: unknown): value is TensorValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "shape" in value && "dtype" in value;
}

function lambdaValue(value: RuntimeValue): value is LambdaValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "parameter" in value && "body" in value;
}

function list(value: RuntimeValue | undefined): value is readonly RuntimeValue[] { return Array.isArray(value); }

function index(axis: number, rank: number, allowEnd = false): number | undefined {
  const normalized = axis < 0 ? rank + axis : axis;
  return normalized >= 0 && normalized < (allowEnd ? rank + 1 : rank) ? normalized : undefined;
}

function at(shape: readonly DimensionValue[], axis: number, trace: readonly string[]): Evaluation {
  const position = index(axis, shape.length);
  return position === undefined ? err("axis out of range", trace) : ok(shape[position], trace);
}

function normalizeAxis(rawAxis: number, rank: number, trace: readonly string[]): Evaluation {
  const normalized = index(rawAxis, rank);
  return normalized === undefined ? err("axis out of range", trace) : ok(normalized, trace);
}

function arithmetic(op: string, left: DimensionValue, right: DimensionValue): DimensionValue {
  return dimensionOperation(op === "+" ? "add" : op === "-" ? "sub" : op === "*" ? "mul" : op === "/" ? "div" : op === "//" ? "floor_div" : "mod", [left, right]);
}

function isComparisonOperator(op: string): op is ">" | ">=" | "<" | "<=" {
  return op === ">" || op === ">=" || op === "<" || op === "<=";
}

function same(left: RuntimeValue, right: RuntimeValue): boolean {
  if (isDimensionValue(left) && isDimensionValue(right)) return equalDimensions(left, right);
  if (list(left) && list(right)) return left.length === right.length && left.every((value, index) => same(value, right[index]));
  return left === right;
}
