import type {
  CompiledTypeSignatureV2, DimensionPattern, InputGroup, PatternShape,
  SchemaDiagnostic, SchemaResult, ShapeDefinition, TypeConstraint,
} from "./model";
import { compileExpression } from "../expr";

export interface TypeSignatureSchemaOptions {
  /** Parameter names declared by the containing stereotype. */
  readonly parameterNames?: Iterable<string>;
}

/** Decode v2 JSON without parsing or evaluating its expression source. */
export function compileTypeSignature(raw: unknown, options: TypeSignatureSchemaOptions = {}): SchemaResult {
  const errors: SchemaDiagnostic[] = [];
  const parameters = new Set(options.parameterNames ?? []);
  const root = objectAt(raw, "", errors);
  if (!root) return { ok: false, errors };
  const symbols = collectDeclaredSymbols(root);
  rejectUnknownKeys(root, ["version", "inputs", "output", "constraints", "from_dtype", "to_dtype"], "", errors);
  expectLiteral(root.version, 2, "/version", errors);

  const inputsRaw = arrayAt(root.inputs, "/inputs", errors);
  const inputs = inputsRaw?.map((group, index) => readInputGroup(group, `/inputs/${index}`, parameters, symbols, errors)) ?? [];
  validateGroups(inputs, errors);
  const output = readShape(root.output, "/output", parameters, symbols, errors);
  validateSymbolScopes(inputs, output, errors);
  const constraints = root.constraints === undefined ? undefined : readConstraints(root.constraints, "/constraints", errors, parameters, symbols);
  const fromDtype = root.from_dtype === undefined ? undefined : readExpression(root.from_dtype, "/from_dtype", errors, "dtype", parameters, symbols);
  const toDtype = readExpression(root.to_dtype, "/to_dtype", errors, "dtype", parameters, symbols);

  if (errors.length || !inputsRaw || !output || !toDtype || inputs.some((input) => !input)) return { ok: false, errors };
  const value: CompiledTypeSignatureV2 = {
    version: 2,
    inputs: inputs as InputGroup[],
    output,
    ...(constraints ? { constraints } : {}),
    ...(fromDtype ? { from_dtype: fromDtype } : {}),
    to_dtype: toDtype,
  };
  return { ok: true, value: deepFreeze(value) };
}

function readInputGroup(raw: unknown, pointer: string, parameters: Set<string>, symbols: Set<string>, errors: SchemaDiagnostic[]): InputGroup | undefined {
  const value = objectAt(raw, pointer, errors);
  if (!value) return undefined;
  rejectUnknownKeys(value, ["lower", "upper", "label", "pattern"], pointer, errors);
  const lower = integerAt(value.lower, `${pointer}/lower`, errors);
  const upper = value.upper === null ? null : integerAt(value.upper, `${pointer}/upper`, errors);
  if (lower !== undefined && lower < 0) error(errors, `${pointer}/lower`, "must be at least 0");
  if (upper !== undefined && upper !== null && upper < 0) error(errors, `${pointer}/upper`, "must be at least 0");
  if (lower !== undefined && typeof upper === "number" && lower > upper) error(errors, pointer, "lower must not exceed upper");
  const label = value.label === undefined ? undefined : nonEmptyString(value.label, `${pointer}/label`, errors);
  const pattern = readPattern(value.pattern, `${pointer}/pattern`, parameters, symbols, errors);
  return lower === undefined || upper === undefined || !pattern ? undefined : { lower, upper, ...(label ? { label } : {}), pattern };
}

function readShape(raw: unknown, pointer: string, parameters: Set<string>, symbols: Set<string>, errors: SchemaDiagnostic[]): ShapeDefinition | undefined {
  const value = objectAt(raw, pointer, errors);
  if (!value || typeof value.kind !== "string") { error(errors, `${pointer}/kind`, "must be a shape-definition kind"); return undefined; }
  if (value.kind === "pattern") return readPattern(value, pointer, parameters, symbols, errors);
  if (value.kind === "computed_shape") {
    rejectUnknownKeys(value, ["kind", "expr"], pointer, errors);
    const expr = readExpression(value.expr, `${pointer}/expr`, errors, "shape", parameters, symbols);
    return expr ? { kind: "computed_shape", expr } : undefined;
  }
  if (value.kind === "einsum") {
    rejectUnknownKeys(value, ["kind", "equation"], pointer, errors);
    const equation = objectAt(value.equation, `${pointer}/equation`, errors);
    if (equation) rejectUnknownKeys(equation, ["parameter"], `${pointer}/equation`, errors);
    const parameter = equation && parameterName(equation.parameter, `${pointer}/equation/parameter`, parameters, errors);
    return parameter ? { kind: "einsum", equation: { parameter } } : undefined;
  }
  error(errors, `${pointer}/kind`, "must be pattern, computed_shape, or einsum");
  return undefined;
}

function readPattern(raw: unknown, pointer: string, parameters: Set<string>, symbols: Set<string>, errors: SchemaDiagnostic[]): PatternShape | undefined {
  const value = objectAt(raw, pointer, errors);
  if (!value) return undefined;
  rejectUnknownKeys(value, ["kind", "dims"], pointer, errors);
  expectLiteral(value.kind, "pattern", `${pointer}/kind`, errors);
  const dimsRaw = arrayAt(value.dims, `${pointer}/dims`, errors);
  const dims = dimsRaw?.map((dim, index) => readDimension(dim, `${pointer}/dims/${index}`, parameters, symbols, errors)) ?? [];
  if (dims.filter((dim) => dim?.kind === "wildcard").length > 1) error(errors, `${pointer}/dims`, "contains more than one wildcard");
  return dimsRaw && dims.every(Boolean) ? { kind: "pattern", dims: dims as DimensionPattern[] } : undefined;
}

function readDimension(raw: unknown, pointer: string, parameters: Set<string>, symbols: Set<string>, errors: SchemaDiagnostic[]): DimensionPattern | undefined {
  const value = objectAt(raw, pointer, errors);
  if (!value || typeof value.kind !== "string") { error(errors, `${pointer}/kind`, "must be a dimension kind"); return undefined; }
  if (value.kind === "wildcard") { rejectUnknownKeys(value, ["kind"], pointer, errors); return { kind: "wildcard" }; }
  if (value.kind === "const") {
    rejectUnknownKeys(value, ["kind", "value"], pointer, errors);
    const number = integerAt(value.value, `${pointer}/value`, errors);
    if (number !== undefined && number <= 0) error(errors, `${pointer}/value`, "must be positive");
    return number !== undefined && number > 0 ? { kind: "const", value: number } : undefined;
  }
  if (value.kind === "symbolic") {
    rejectUnknownKeys(value, ["kind", "name", "scope"], pointer, errors);
    const name = nonEmptyString(value.name, `${pointer}/name`, errors);
    const scope = value.scope === "global" || value.scope === "local" ? value.scope : undefined;
    if (!scope) error(errors, `${pointer}/scope`, "must be global or local");
    return name && scope ? { kind: "symbolic", name, scope } : undefined;
  }
  if (value.kind === "param_ref" || value.kind === "param_spread") {
    rejectUnknownKeys(value, ["kind", "name"], pointer, errors);
    const name = parameterName(value.name, `${pointer}/name`, parameters, errors);
    return name ? { kind: value.kind, name } : undefined;
  }
  if (value.kind === "computed") {
    rejectUnknownKeys(value, ["kind", "expr"], pointer, errors);
    const expr = readExpression(value.expr, `${pointer}/expr`, errors, "dimension", parameters, symbols);
    return expr ? { kind: "computed", expr } : undefined;
  }
  error(errors, `${pointer}/kind`, "must be const, wildcard, symbolic, param_ref, param_spread, or computed");
  return undefined;
}

function readConstraints(raw: unknown, pointer: string, errors: SchemaDiagnostic[], parameters: Set<string>, symbols: Set<string>): TypeConstraint[] | undefined {
  const values = arrayAt(raw, pointer, errors);
  if (!values) return undefined;
  return values.map((rawConstraint, index) => {
    const path = `${pointer}/${index}`;
    const value = objectAt(rawConstraint, path, errors);
    if (value) rejectUnknownKeys(value, ["condition", "message", "severity", "category"], path, errors);
    const condition = value && readExpression(value.condition, `${path}/condition`, errors, "constraint", parameters, symbols);
    const message = value?.message === undefined ? undefined : nonEmptyString(value.message, `${path}/message`, errors);
    const severity = value?.severity === undefined ? undefined : value.severity === "error" || value.severity === "warning" ? value.severity : undefined;
    if (value?.severity !== undefined && !severity) error(errors, `${path}/severity`, "must be error or warning");
    const category = value?.category === undefined ? undefined : nonEmptyString(value.category, `${path}/category`, errors);
    return condition ? { condition, ...(message ? { message } : {}), ...(severity ? { severity } : {}), ...(category ? { category } : {}) } : undefined;
  }).filter((constraint): constraint is TypeConstraint => Boolean(constraint));
}

function validateGroups(groups: Array<InputGroup | undefined>, errors: SchemaDiagnostic[]): void {
  const labels = new Set<string>();
  let variable = 0;
  groups.forEach((group, index) => {
    if (!group) return;
    if (group.lower !== group.upper) variable += 1;
    if (group.label && (labels.has(group.label) || !labels.add(group.label))) error(errors, `/inputs/${index}/label`, "must be unique");
  });
  if (variable > 1) error(errors, "/inputs", "contains multiple variable-width groups with ambiguous allocation");
}

function validateSymbolScopes(groups: Array<InputGroup | undefined>, output: ShapeDefinition | undefined, errors: SchemaDiagnostic[]): void {
  const scopes = new Map<string, "global" | "local">();
  const collect = (pattern: PatternShape | undefined, pointer: string): void => {
    pattern?.dims.forEach((dimension, index) => {
      if (dimension.kind !== "symbolic") return;
      const previous = scopes.get(dimension.name);
      if (previous && previous !== dimension.scope) error(errors, `${pointer}/dims/${index}/scope`, `symbol '${dimension.name}' cannot use both local and global scope`);
      scopes.set(dimension.name, dimension.scope);
    });
  };
  groups.forEach((group, index) => collect(group?.pattern, `/inputs/${index}/pattern`));
  if (output?.kind === "pattern") collect(output, "/output");
}

function collectDeclaredSymbols(raw: unknown): Set<string> {
  const symbols = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.kind === "symbolic" && typeof record.name === "string" && record.name.trim() !== "") symbols.add(record.name);
    Object.values(record).forEach(visit);
  };
  visit(raw);
  return symbols;
}

function parameterName(raw: unknown, pointer: string, parameters: Set<string>, errors: SchemaDiagnostic[]): string | undefined {
  const name = nonEmptyString(raw, pointer, errors);
  if (name && !parameters.has(name)) error(errors, pointer, `references undeclared parameter '${name}'`);
  return name && parameters.has(name) ? name : undefined;
}
function readExpression(raw: unknown, pointer: string, errors: SchemaDiagnostic[], expected: "dimension" | "shape" | "constraint" | "dtype", parameters: Set<string>, symbols: Set<string>): string | undefined {
  const source = nonEmptyString(raw, pointer, errors);
  if (!source) return undefined;
  const compiled = compileExpression(source, expected, { parameterNames: parameters, symbols });
  if (!compiled.ok) { error(errors, pointer, `${compiled.error.message} at source span ${compiled.error.start}-${compiled.error.end}`); return undefined; }
  return source;
}
function nonEmptyString(raw: unknown, pointer: string, errors: SchemaDiagnostic[]): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") { error(errors, pointer, "must be a non-empty expression/source string"); return undefined; }
  return raw;
}
function integerAt(raw: unknown, pointer: string, errors: SchemaDiagnostic[]): number | undefined {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) { error(errors, pointer, "must be a safe integer"); return undefined; }
  return raw;
}
function arrayAt(raw: unknown, pointer: string, errors: SchemaDiagnostic[]): unknown[] | undefined {
  if (!Array.isArray(raw)) { error(errors, pointer, "must be an array"); return undefined; }
  return raw;
}
function objectAt(raw: unknown, pointer: string, errors: SchemaDiagnostic[]): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) { error(errors, pointer, "must be an object"); return undefined; }
  return raw as Record<string, unknown>;
}
function expectLiteral(raw: unknown, expected: unknown, pointer: string, errors: SchemaDiagnostic[]): void { if (raw !== expected) error(errors, pointer, `must equal ${JSON.stringify(expected)}`); }
function error(errors: SchemaDiagnostic[], pointer: string, message: string): void { errors.push({ pointer, message }); }
function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], pointer: string, errors: SchemaDiagnostic[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) error(errors, `${pointer}/${escapePointerToken(key)}`, "is not allowed in a v2 type signature");
  }
}
function escapePointerToken(token: string): string { return token.replace(/~/g, "~0").replace(/\//g, "~1"); }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}
