import type { DimensionValue, Evaluation, TensorValue } from "../expr";
import type { ScopeGraph } from "../core/scopeGraph";
import { evaluateSignature, type SignatureBindings, type SignatureEvaluation } from "./signatureEvaluator";
import type { CompiledTypeSignatureV2 } from "./model";
import type { NormalizedParameterValue } from "./parameterValues";

export interface SubflowNodeDefinition {
  readonly id: string;
  /** The external tensor is injected only at this declared structural boundary. */
  readonly boundary?: true;
  readonly signature?: CompiledTypeSignatureV2;
  readonly parameters?: Readonly<Record<string, NormalizedParameterValue>>;
  /** A nested scope is an ordinary node capability, not an operation family. */
  readonly subflow?: SubflowDefinition;
}

export interface SubflowDefinition {
  readonly graph: ScopeGraph<SubflowNodeDefinition>;
}

export interface SubflowApplication {
  readonly value?: TensorValue;
  readonly bindings: SignatureBindings;
  readonly diagnostics: readonly SubflowDiagnostic[];
}

export interface SubflowDiagnostic {
  readonly nodeId: string;
  readonly message: string;
  readonly trace: readonly string[];
  readonly severity: "error" | "warning";
  readonly location: string;
  readonly category?: string;
}

/** Apply a scope once with fresh local bindings and inherited global bindings. */
export function applySubflow(definition: SubflowDefinition, input: TensorValue, inherited: SignatureBindings = {}, trace: readonly string[] = []): SubflowApplication {
  validateBoundaries(definition.graph);
  const values = new Map<string, TensorValue>();
  const diagnostics: SubflowDiagnostic[] = [];
  let global = new Map(inherited.global);
  const applicationCache = new Map<string, Evaluation>();
  const wrapperMessages = new Set<string>();

  for (const id of definition.graph.topologicalOrder) {
    const node = definition.graph.nodes.find((candidate) => candidate.id === id)!;
    if (id === definition.graph.entryId && node.boundary) {
      values.set(id, input);
      continue;
    }
    const inputs = id === definition.graph.entryId
      ? [input]
      : definition.graph.predecessors.get(id)!.map((source) => values.get(source)).filter((value): value is TensorValue => value !== undefined);
    if (id !== definition.graph.entryId && inputs.length !== definition.graph.predecessors.get(id)!.length) {
      diagnostics.push({ nodeId: id, message: "input is blocked by an earlier subflow error", trace, severity: "error", location: "inputs" });
      continue;
    }
    if (!node.signature) {
      diagnostics.push({ nodeId: id, message: "subflow node has no type signature", trace, severity: "error", location: "signature" });
      continue;
    }
    const result = evaluateSignature(node.signature, inputs, node.parameters ?? {}, { global }, {
      applySubflow: (tensor, callbackTrace) => {
        if (!node.subflow) return { kind: "deferred", trace: callbackTrace };
        const iterationTrace = callbackTrace.filter((entry) => entry.startsWith("iteration="));
        const key = `${id}:${iterationTrace.join("/")}:${tensor.dtype}:${JSON.stringify(tensor.shape)}`;
        const cached = applicationCache.get(key);
        if (cached) return cached;
        const nested = applySubflow(node.subflow, tensor, { global }, callbackTrace);
        for (const nestedDiagnostic of nested.diagnostics) appendDiagnostic(diagnostics, nestedDiagnostic);
        for (const [name, value] of nested.bindings.global ?? []) global.set(name, value);
        const firstFailure = nested.diagnostics[0];
        const evaluation: Evaluation = nested.value
          ? { kind: "value", value: nested.value, trace: callbackTrace }
          : { kind: "error", message: firstFailure ? `node=${firstFailure.nodeId}: ${firstFailure.message}${firstFailure.trace.length ? ` (${firstFailure.trace.join(", ")})` : ""}` : `node=${id}: subflow application failed`, trace: firstFailure?.trace ?? callbackTrace };
        if (evaluation.kind === "error") wrapperMessages.add(evaluation.message);
        applicationCache.set(key, evaluation);
        return evaluation;
      },
    });
    global = mergeGlobals(global, result.bindings.global);
    collectDiagnostics(diagnostics, id, result, trace, wrapperMessages);
    if (result.ok && result.output) values.set(id, result.output);
  }
  return { value: diagnostics.some((diagnostic) => diagnostic.severity === "error") ? undefined : values.get(definition.graph.exitId), bindings: { global, local: new Map(), parameters: new Map() }, diagnostics };
}

function validateBoundaries(graph: ScopeGraph<SubflowNodeDefinition>): void {
  const boundaries = graph.nodes.filter((node) => node.boundary);
  if (boundaries.length > 1) throw new Error(`Scope must have at most one boundary, found ${boundaries.length}`);
  if (boundaries.length === 1 && boundaries[0].id !== graph.entryId) throw new Error("Scope boundary must be the structural entry");
}

function mergeGlobals(current: ReadonlyMap<string, DimensionValue>, learned: ReadonlyMap<string, DimensionValue>): Map<string, DimensionValue> {
  return new Map([...current, ...learned]);
}

function appendDiagnostic(target: SubflowDiagnostic[], diagnostic: SubflowDiagnostic): void {
  if (!target.some((item) => item.nodeId === diagnostic.nodeId && item.message === diagnostic.message && item.location === diagnostic.location)) target.push(diagnostic);
}

function collectDiagnostics(target: SubflowDiagnostic[], nodeId: string, result: SignatureEvaluation, trace: readonly string[], wrapperMessages: ReadonlySet<string>): void {
  for (const diagnostic of result.diagnostics) {
    if (!wrapperMessages.has(diagnostic.message)) appendDiagnostic(target, { nodeId, message: diagnostic.message, trace, severity: diagnostic.severity, location: diagnostic.location, ...(diagnostic.category ? { category: diagnostic.category } : {}) });
  }
}
