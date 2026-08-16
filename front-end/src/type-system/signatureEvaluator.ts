import { compileExpression, evaluateCompiled, isDimensionValue, type DimensionValue, type Evaluation, type TensorValue } from "../expr";
import type { CompiledTypeSignatureV2, ShapeDefinition } from "./model";
import type { NormalizedParameterValue } from "./parameterValues";
import { allocateInputGroups } from "./inputGroups";
import { matchPattern, resolvePattern, type PatternBindings, type PatternDiagnostic, type PatternSuggestion } from "./shapePatterns";
import { evaluateEinsumShape } from "./einsumShape";

export interface SignatureBindings { readonly global?: ReadonlyMap<string, DimensionValue>; readonly local?: ReadonlyMap<string, DimensionValue>; readonly parameters?: ReadonlyMap<string, DimensionValue | readonly DimensionValue[]>; }
export interface EvaluatorCapabilities { readonly applySubflow?: (tensor: TensorValue, trace: readonly string[]) => Evaluation; }
export interface SignatureDiagnostic { readonly code: string; readonly message: string; readonly location: string; readonly severity: "error" | "warning"; readonly category?: string; }
export interface SignatureSuggestion { readonly parameter: string; readonly value: DimensionValue | readonly DimensionValue[]; readonly message: string; readonly location: string; }
export type SignatureEvaluation = { readonly ok: boolean; readonly output?: TensorValue; readonly bindings: { readonly global: ReadonlyMap<string, DimensionValue>; readonly local: ReadonlyMap<string, DimensionValue>; readonly parameters: ReadonlyMap<string, DimensionValue | readonly DimensionValue[]> }; readonly diagnostics: readonly SignatureDiagnostic[]; readonly suggestions: readonly SignatureSuggestion[]; readonly deferred: boolean; };

const expressionParams = (parameters: Readonly<Record<string, NormalizedParameterValue>>): Record<string, unknown> => Object.fromEntries(Object.entries(parameters).flatMap(([key, value]) => value.status === "resolved" ? [[key, value.value]] : []));
const diagnostic = (item: PatternDiagnostic, location: string): SignatureDiagnostic => ({ code: item.code, message: item.message, location, severity: "error" });

/** Graph-independent application of a compiled signature to ordered tensors. */
export function evaluateSignature(signature: CompiledTypeSignatureV2, inputs: readonly TensorValue[], parameters: Readonly<Record<string, NormalizedParameterValue>>, bindings: SignatureBindings = {}, capabilities: EvaluatorCapabilities = {}): SignatureEvaluation {
  const diagnostics: SignatureDiagnostic[] = [];
  const suggestions: SignatureSuggestion[] = [];
  const allocation = allocateInputGroups(signature.inputs, inputs);
  const state: PatternBindings = { global: new Map(bindings.global), local: new Map(bindings.local), parameters: new Map(bindings.parameters) };
  if (!allocation.ok) return result(false, state, diagnostics.concat({ code: "arity", message: allocation.message, location: "inputs", severity: "error" }), suggestions, false);
  const grouped: readonly (readonly TensorValue[])[] = allocation.groups.map((group) => group.inputs);
  let firstWildcard: readonly DimensionValue[] = [];
  let capturedFirstWildcard = false;
  for (const group of allocation.groups) {
    for (let index = 0; index < group.inputs.length; index += 1) {
      const match = matchPattern(group.group.pattern, group.inputs[index], parameters, state);
      state.global = match.bindings.global;
      state.local = match.bindings.local;
      state.parameters = match.bindings.parameters;
      if (!capturedFirstWildcard) {
        firstWildcard = match.wildcard;
        capturedFirstWildcard = true;
      }
      diagnostics.push(...match.diagnostics.map((item) => diagnostic(item, `inputs/${group.index}/${index}`)));
      suggestions.push(...match.suggestions.map((item) => ({ ...item, location: `inputs/${group.index}/${index}` })));
    }
  }
  if (signature.from_dtype) validateInputDtype(signature.from_dtype, inputs, grouped, parameters, state, capabilities, diagnostics);
  const outputShape = resolveOutput(signature.output, inputs, grouped, parameters, state, firstWildcard, capabilities, diagnostics);
  const dtype = evaluateDtype(signature.to_dtype, inputs, grouped, parameters, state, capabilities, "to_dtype", diagnostics);
  for (let index = 0; index < (signature.constraints ?? []).length; index += 1) {
    const constraint = signature.constraints![index];
    const compiled = compile(constraint.condition, "constraint", parameters, state);
    if (!compiled.ok) { diagnostics.push({ code: "constraint", message: compiled.error.message, location: `constraints/${index}`, severity: "error", category: constraint.category }); continue; }
    const value = evaluateCompiled(compiled.value, context(grouped, parameters, state, firstWildcard, capabilities));
    if (value.kind === "error") diagnostics.push({ code: "constraint", message: value.message, location: `constraints/${index}`, severity: "error", category: constraint.category });
    else if (value.kind === "value" && value.value !== true) diagnostics.push({ code: "constraint", message: constraint.message ?? `constraint '${constraint.condition}' failed`, location: `constraints/${index}`, severity: constraint.severity ?? "error", category: constraint.category });
    else if (value.kind === "deferred") diagnostics.push({ code: "deferred_constraint", message: `constraint '${constraint.condition}' is unresolved`, location: `constraints/${index}`, severity: constraint.severity ?? "error", category: constraint.category });
  }
  const deferred = diagnostics.some((item) => item.code.startsWith("deferred"));
  const errors = diagnostics.some((item) => item.severity === "error");
  return result(!errors && !!outputShape && !!dtype, state, diagnostics, suggestions, deferred, outputShape && dtype ? { shape: outputShape, dtype } : undefined);
}

function resolveOutput(definition: ShapeDefinition, inputs: readonly TensorValue[], grouped: readonly (readonly TensorValue[])[], parameters: Readonly<Record<string, NormalizedParameterValue>>, state: PatternBindings, wildcard: readonly DimensionValue[], capabilities: EvaluatorCapabilities, diagnostics: SignatureDiagnostic[]): readonly DimensionValue[] | undefined {
  if (definition.kind === "pattern") { const resolved = resolvePattern(definition, parameters, state, wildcard); diagnostics.push(...resolved.diagnostics.map((item) => diagnostic(item, "output"))); return resolved.shape; }
  if (definition.kind === "einsum") { const value = parameters[definition.equation.parameter]; if (value?.status !== "resolved" || typeof value.value !== "string") { diagnostics.push({ code: "einsum", message: `equation parameter '${definition.equation.parameter}' is not a resolved string`, location: "output", severity: "error" }); return undefined; } const resolved = evaluateEinsumShape(value.value, inputs); if (!resolved.ok) { diagnostics.push({ code: "einsum", message: resolved.message, location: "output", severity: "error" }); return undefined; } return resolved.shape; }
  const compiled = compile(definition.expr, "shape", parameters, state);
  if (!compiled.ok) { diagnostics.push({ code: "computed_shape", message: compiled.error.message, location: "output", severity: "error" }); return undefined; }
  const value = evaluateCompiled(compiled.value, context(grouped, parameters, state, wildcard, capabilities));
  if (value.kind === "value" && Array.isArray(value.value) && value.value.every(isDimensionValue)) return value.value;
  diagnostics.push({ code: value.kind === "deferred" ? "deferred_shape" : "computed_shape", message: value.kind === "error" ? value.message : "computed output shape is unresolved", location: "output", severity: "error" });
  return undefined;
}

function evaluateDtype(source: string, inputs: readonly TensorValue[], grouped: readonly (readonly TensorValue[])[], parameters: Readonly<Record<string, NormalizedParameterValue>>, state: PatternBindings, capabilities: EvaluatorCapabilities, location: string, diagnostics: SignatureDiagnostic[]): string | undefined {
  if (/^(?:float16|float32|float64|int32|int64|bool)$/.test(source)) return source;
  const compiled = compile(source, "dtype", parameters, state);
  if (!compiled.ok) { diagnostics.push({ code: "dtype", message: compiled.error.message, location, severity: "error" }); return undefined; }
  const value = evaluateCompiled(compiled.value, context(grouped, parameters, state, [], capabilities));
  if (value.kind === "value" && typeof value.value === "string") return value.value;
  diagnostics.push({ code: value.kind === "deferred" ? "deferred_dtype" : "dtype", message: value.kind === "error" ? value.message : `${location} is unresolved`, location, severity: "error" });
  return undefined;
}

function validateInputDtype(source: string, inputs: readonly TensorValue[], grouped: readonly (readonly TensorValue[])[], parameters: Readonly<Record<string, NormalizedParameterValue>>, state: PatternBindings, capabilities: EvaluatorCapabilities, diagnostics: SignatureDiagnostic[]): void {
  const expected = evaluateDtype(source, inputs, grouped, parameters, state, capabilities, "from_dtype", diagnostics);
  if (!expected) return;
  for (let index = 0; index < inputs.length; index += 1) {
    if (inputs[index].dtype !== expected) diagnostics.push({ code: "dtype", message: `expected input dtype '${expected}', got '${inputs[index].dtype}'`, location: `inputs/${index}/dtype`, severity: "warning" });
  }
}

function context(inputs: readonly (readonly TensorValue[])[], parameters: Readonly<Record<string, NormalizedParameterValue>>, state: PatternBindings, wildcard: readonly DimensionValue[], capabilities: EvaluatorCapabilities) { return { inputs, params: { ...expressionParams(parameters), ...Object.fromEntries(state.parameters) }, symbols: new Map([...state.global, ...state.local]), capturedDimensions: wildcard, applySubflow: capabilities.applySubflow }; }
function result(ok: boolean, bindings: PatternBindings, diagnostics: readonly SignatureDiagnostic[], suggestions: readonly SignatureSuggestion[], deferred: boolean, output?: TensorValue): SignatureEvaluation {
  return { ok, ...(output ? { output } : {}), bindings: { global: bindings.global, local: bindings.local, parameters: bindings.parameters }, diagnostics, suggestions, deferred };
}
function compile(source: string, expected: "dimension" | "shape" | "constraint" | "dtype", parameters: Readonly<Record<string, NormalizedParameterValue>>, state: PatternBindings) {
  return compileExpression(source, expected, { parameterNames: Object.keys(parameters), symbols: [...state.global.keys(), ...state.local.keys()] });
}
