import { compileExpression, equalDimensions, evaluateCompiled, formatDimension, isDimensionValue, symbol, type DimensionValue, type TensorValue } from "../expr";
import type { DimensionPattern, PatternShape } from "./model";
import type { NormalizedParameterValue } from "./parameterValues";

type BoundParameter = DimensionValue | readonly DimensionValue[];

export interface PatternBindings {
  global: Map<string, DimensionValue>;
  local: Map<string, DimensionValue>;
  parameters: Map<string, BoundParameter>;
}

export interface PatternDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly dimension?: number;
  readonly parameter?: string;
}

export interface PatternSuggestion {
  readonly parameter: string;
  readonly value: DimensionValue | readonly DimensionValue[];
  readonly message: string;
}

export interface PatternMatch {
  readonly ok: boolean;
  readonly bindings: PatternBindings;
  readonly wildcard: readonly DimensionValue[];
  readonly diagnostics: readonly PatternDiagnostic[];
  readonly suggestions: readonly PatternSuggestion[];
}

const clone = (bindings: PatternBindings): PatternBindings => ({
  global: new Map(bindings.global),
  local: new Map(bindings.local),
  parameters: new Map(bindings.parameters),
});

function resolvedParameters(params: Readonly<Record<string, NormalizedParameterValue>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).flatMap(([name, value]) => value.status === "resolved" ? [[name, value.value]] : []));
}

function spreadValue(name: string, parameters: Readonly<Record<string, NormalizedParameterValue>>, bindings: PatternBindings): readonly DimensionValue[] | undefined {
  const parameter = parameters[name];
  if (parameter?.status === "resolved") return Array.isArray(parameter.value) ? parameter.value : typeof parameter.value === "number" ? [parameter.value] : undefined;
  const bound = bindings.parameters.get(name);
  return Array.isArray(bound) ? bound : undefined;
}

const isConcreteDimension = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const validSpread = (value: unknown): value is readonly number[] => Array.isArray(value) && value.every(isConcreteDimension);
const invalidDimensionMessage = (name: string) => `parameter '${name}' must be a positive safe integer`;

function expressionOptions(parameters: Readonly<Record<string, NormalizedParameterValue>>, bindings: PatternBindings) {
  return { parameterNames: Object.keys(parameters), symbols: [...bindings.global.keys(), ...bindings.local.keys()] };
}

export function matchPattern(
  pattern: PatternShape,
  tensor: TensorValue,
  parameters: Readonly<Record<string, NormalizedParameterValue>>,
  bindings: PatternBindings,
): PatternMatch {
  const diagnostics: PatternDiagnostic[] = [];
  const suggestions: PatternSuggestion[] = [];
  const next = clone(bindings);
  const spreads = pattern.dims.filter((dimension): dimension is Extract<DimensionPattern, { kind: "param_spread" }> => dimension.kind === "param_spread");
  const wildcardIndex = pattern.dims.findIndex((dimension) => dimension.kind === "wildcard");
  const unresolvedSpreads = spreads.filter((spread) => {
    const parameter = parameters[spread.name];
    return parameter?.status !== "resolved" && !Array.isArray(next.parameters.get(spread.name));
  });

  for (const spread of spreads) {
    const parameter = parameters[spread.name];
    if (parameter?.status === "invalid") diagnostics.push({ code: "parameter", parameter: spread.name, message: `parameter spread '${spread.name}' is invalid: ${parameter.reason}` });
    if (parameter?.status === "resolved" && typeof parameter.value === "number" && !isConcreteDimension(parameter.value)) diagnostics.push({ code: "parameter", parameter: spread.name, message: invalidDimensionMessage(spread.name) });
    if (parameter?.status === "resolved" && Array.isArray(parameter.value) && !validSpread(parameter.value)) diagnostics.push({ code: "parameter", parameter: spread.name, message: `parameter spread '${spread.name}' must contain positive safe integers` });
    if (parameter?.status === "resolved" && !Array.isArray(parameter.value) && typeof parameter.value !== "number") diagnostics.push({ code: "parameter", parameter: spread.name, message: `parameter spread '${spread.name}' must be a number or list` });
  }
  if (diagnostics.length) return { ok: false, bindings: next, wildcard: [], diagnostics, suggestions };
  if (unresolvedSpreads.length > 1 || (unresolvedSpreads.length && wildcardIndex >= 0)) {
    const names = unresolvedSpreads.map((spread) => `'${spread.name}'`).join(", ");
    return { ok: false, bindings: next, wildcard: [], suggestions, diagnostics: [{ code: "ambiguous_spread", message: `cannot determine the span of unset spread ${names}` }] };
  }

  const knownSpreadWidth = spreads.reduce((sum, spread) => sum + (spreadValue(spread.name, parameters, next)?.length ?? 0), 0);
  const fixed = pattern.dims.length - (wildcardIndex >= 0 ? 1 : 0) - spreads.length + knownSpreadWidth;
  const unknownSpreadWidth = unresolvedSpreads.length ? tensor.shape.length - fixed : 0;
  if (unknownSpreadWidth < 0 || (wildcardIndex < 0 && tensor.shape.length !== fixed + unknownSpreadWidth) || (wildcardIndex >= 0 && tensor.shape.length < fixed)) {
    return { ok: false, bindings: next, wildcard: [], suggestions, diagnostics: [{ code: "rank", message: `input rank ${tensor.shape.length} does not match the pattern` }] };
  }

  const wildcardWidth = wildcardIndex >= 0 ? tensor.shape.length - fixed : 0;
  let cursor = 0;
  let wildcard: readonly DimensionValue[] = [];
  for (const dimension of pattern.dims) {
    if (dimension.kind === "wildcard") {
      wildcard = tensor.shape.slice(cursor, cursor + wildcardWidth);
      cursor += wildcardWidth;
      continue;
    }
    if (dimension.kind === "param_spread") {
      const parameter = parameters[dimension.name];
      const width = spreadValue(dimension.name, parameters, next)?.length ?? unknownSpreadWidth;
      const values = tensor.shape.slice(cursor, cursor + width);
      cursor += width;
      if (parameter?.status !== "resolved" && !next.parameters.has(dimension.name)) {
        next.parameters.set(dimension.name, values);
        suggestions.push({ parameter: dimension.name, value: values, message: `set '${dimension.name}' to (${values.map(formatDimension).join(", ")})` });
      }
      continue;
    }
    const actual = tensor.shape[cursor++];
    if (dimension.kind === "const" && !equalDimensions(actual, dimension.value)) diagnostics.push({ code: "const", dimension: cursor - 1, message: `expected dimension ${dimension.value}, got ${formatDimension(actual)}` });
    if (dimension.kind === "symbolic") {
      const scope = dimension.scope === "global" ? next.global : next.local;
      const known = scope.get(dimension.name);
      if (known === undefined) scope.set(dimension.name, actual);
      else if (!equalDimensions(known, actual)) diagnostics.push({ code: "symbol", dimension: cursor - 1, message: `${dimension.scope} symbol '${dimension.name}' is ${formatDimension(known)}, got ${formatDimension(actual)}` });
    }
    if (dimension.kind === "param_ref") {
      const parameter = parameters[dimension.name];
      const bound = next.parameters.get(dimension.name);
      if (parameter?.status === "invalid") diagnostics.push({ code: "parameter", parameter: dimension.name, message: `parameter '${dimension.name}' is invalid: ${parameter.reason}` });
      else if (parameter?.status === "resolved") {
        if (!isConcreteDimension(parameter.value)) diagnostics.push({ code: "parameter", parameter: dimension.name, message: invalidDimensionMessage(dimension.name) });
        else if (!equalDimensions(parameter.value, actual)) diagnostics.push({ code: "parameter", parameter: dimension.name, message: `parameter '${dimension.name}' is ${parameter.value}, got ${formatDimension(actual)}` });
      }
      else if (bound !== undefined && !Array.isArray(bound) && !equalDimensions(bound as DimensionValue, actual)) diagnostics.push({ code: "parameter", parameter: dimension.name, message: `bound parameter '${dimension.name}' is ${formatDimension(bound as DimensionValue)}, got ${formatDimension(actual)}` });
      else if (bound === undefined) {
        next.parameters.set(dimension.name, actual);
        if (typeof actual === "number") suggestions.push({ parameter: dimension.name, value: actual, message: `set '${dimension.name}' to ${actual}` });
      }
    }
    if (dimension.kind === "computed") {
      const compiled = compileExpression(dimension.expr, "dimension", expressionOptions(parameters, next));
      if (!compiled.ok) diagnostics.push({ code: "computed", message: compiled.error.message });
      else {
        const evaluated = evaluateCompiled(compiled.value, { params: resolvedParameters(parameters), symbols: new Map([...next.global, ...next.local]), capturedDimensions: wildcard });
        if (evaluated.kind === "value" && (!isDimensionValue(evaluated.value) || !equalDimensions(evaluated.value, actual))) diagnostics.push({ code: "computed", dimension: cursor - 1, message: `computed dimension '${dimension.expr}' does not equal ${formatDimension(actual)}` });
        if (evaluated.kind === "error") diagnostics.push({ code: "computed", message: evaluated.message });
        if (evaluated.kind === "deferred") diagnostics.push({ code: "deferred_computed", message: `computed dimension '${dimension.expr}' is unresolved` });
      }
    }
  }
  return { ok: diagnostics.length === 0, bindings: next, wildcard, diagnostics, suggestions };
}

export function resolvePattern(
  pattern: PatternShape,
  parameters: Readonly<Record<string, NormalizedParameterValue>>,
  bindings: PatternBindings,
  wildcard: readonly DimensionValue[],
): { readonly shape?: readonly DimensionValue[]; readonly diagnostics: readonly PatternDiagnostic[] } {
  const shape: DimensionValue[] = [];
  const diagnostics: PatternDiagnostic[] = [];
  for (const dimension of pattern.dims) {
    if (dimension.kind === "const") shape.push(dimension.value);
    else if (dimension.kind === "wildcard") shape.push(...wildcard);
    else if (dimension.kind === "symbolic") {
      const value = (dimension.scope === "global" ? bindings.global : bindings.local).get(dimension.name);
      shape.push(value ?? symbol(dimension.name, dimension.scope));
    } else if (dimension.kind === "param_ref") {
      const parameter = parameters[dimension.name];
      const bound = bindings.parameters.get(dimension.name);
      if (parameter?.status === "invalid") diagnostics.push({ code: "parameter", parameter: dimension.name, message: `parameter '${dimension.name}' is invalid: ${parameter.reason}` });
      else if (parameter?.status === "resolved") {
        if (isConcreteDimension(parameter.value)) shape.push(parameter.value);
        else diagnostics.push({ code: "parameter", parameter: dimension.name, message: invalidDimensionMessage(dimension.name) });
      } else if (isDimensionValue(bound)) shape.push(bound);
      else diagnostics.push({ code: "deferred_parameter", parameter: dimension.name, message: `parameter '${dimension.name}' is unset` });
    } else if (dimension.kind === "param_spread") {
      const parameter = parameters[dimension.name];
      const bound = bindings.parameters.get(dimension.name);
      if (parameter?.status === "invalid") diagnostics.push({ code: "parameter", parameter: dimension.name, message: `parameter spread '${dimension.name}' is invalid: ${parameter.reason}` });
      else if (parameter?.status === "resolved") {
        if (validSpread(parameter.value)) shape.push(...parameter.value);
        else if (isConcreteDimension(parameter.value)) shape.push(parameter.value);
        else if (Array.isArray(parameter.value)) diagnostics.push({ code: "parameter", parameter: dimension.name, message: `parameter spread '${dimension.name}' must contain positive safe integers` });
        else if (typeof parameter.value === "number") diagnostics.push({ code: "parameter", parameter: dimension.name, message: invalidDimensionMessage(dimension.name) });
        else diagnostics.push({ code: "parameter", parameter: dimension.name, message: `parameter spread '${dimension.name}' must be a number or list` });
      } else if (Array.isArray(bound)) shape.push(...bound);
      else diagnostics.push({ code: "deferred_spread", parameter: dimension.name, message: `parameter spread '${dimension.name}' has no concrete length` });
    } else {
      const compiled = compileExpression(dimension.expr, "dimension", expressionOptions(parameters, bindings));
      const evaluated = compiled.ok ? evaluateCompiled(compiled.value, { params: resolvedParameters(parameters), symbols: new Map([...bindings.global, ...bindings.local]), capturedDimensions: wildcard }) : undefined;
      if (evaluated?.kind === "value" && isDimensionValue(evaluated.value)) shape.push(evaluated.value);
      else diagnostics.push({ code: "computed", message: evaluated?.kind === "error" ? evaluated.message : `computed dimension '${dimension.expr}' is unresolved` });
    }
  }
  return diagnostics.length ? { diagnostics } : { shape, diagnostics };
}
