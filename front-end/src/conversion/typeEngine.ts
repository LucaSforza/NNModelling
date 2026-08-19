import type { Edge, Node } from "@xyflow/svelte";
import type { DiagramCore } from "../core/DiagramCore";
import { describeScopeGraph, orderPredecessors } from "../core/scopeGraph";
import { formatDimension, type DimensionValue, type Evaluation, type TensorValue } from "../expr";
import { normalizeParameterValue, type NormalizedParameterValue } from "../type-system/parameterValues";
import { evaluateSignature, type SignatureDiagnostic } from "../type-system/signatureEvaluator";
import { applySubflow, type SubflowDefinition, type SubflowNodeDefinition } from "../type-system/subflowEvaluator";
import type { CompiledTypeSignatureV2 } from "../type-system/model";
import type { NodeTypeAnnotation, TensorType, TypeResult } from "./tensortypes";

const anonymousSubflowSignature: CompiledTypeSignatureV2 = {
  version: 2,
  inputs: [{ lower: 1, upper: 1, pattern: { kind: "pattern", dims: [{ kind: "wildcard" }] } }],
  output: { kind: "computed_shape", expr: "shape(apply(input(0, 0)))" },
  to_dtype: "dtype(apply(input(0, 0)))",
};

/** Production graph adapter for the graph-independent v2 evaluator. */
export class TypeEngine {
  static infer(diagram: DiagramCore): TypeResult {
    const annotations = new Map<string, NodeTypeAnnotation>();
    const errors: TypeResult["errors"] = [];
    const warnings: TypeResult["warnings"] = [];
    const suggestions: TypeResult["suggestions"] = [];
    const nodes = diagram.nodes.filter(node => node.parentId == null);
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const edges = diagram.edges.filter(edge => nodeById.has(edge.source) && nodeById.has(edge.target));
    const traversal = topologicalOrder(nodes, edges);
    const values = new Map<string, TensorValue>();
    let globals = new Map<string, DimensionValue>();

    if (traversal.cycle.length > 0) {
      for (const id of traversal.cycle) {
        errors.push({ nodeId: id, severity: "error", message: "graph contains a directed cycle" });
        annotations.set(id, { nodeId: id, outputType: unknownTensor(), blockedBy: traversal.cycle });
      }
    }
    for (const id of traversal.blocked) {
      const blockedBy = orderPredecessors(edges, id).filter(source => traversal.cycle.includes(source) || traversal.blocked.includes(source));
      errors.push({ nodeId: id, severity: "error", message: "input is blocked by a graph cycle" });
      annotations.set(id, { nodeId: id, outputType: unknownTensor(), blockedBy });
    }
    for (const id of traversal.order) {
      const node = nodeById.get(id)!;
      const predecessors = orderPredecessors(edges, id);
      const blockedBy = predecessors.filter(source => !values.has(source));
      if (blockedBy.length) {
        errors.push({ nodeId: id, severity: "error", message: "input is blocked by an earlier type error" });
        annotations.set(id, { nodeId: id, outputType: unknownTensor(), blockedBy });
        continue;
      }
      const inputs = predecessors.map(source => values.get(source)!);
      const stereotype = diagram.getStereotype(node.data.stereotype as string);
      const signature = stereotype?.typeSignature ?? (node.type === "subflow" ? anonymousSubflowSignature : undefined);
      if (!signature) {
        if (inputs.length === 0) continue;
        errors.push({ nodeId: id, severity: "error", message: "node has no compiled type signature" });
        continue;
      }
      const parameters = normalizedParameters(node, stereotype?.parameters ?? {});
      const definition = node.type === "subflow" ? buildSubflowDefinition(diagram, node, errors) : undefined;
      const nestedSubflowFailures = new Set<string>();
      const result = evaluateSignature(signature, inputs, parameters, { global: globals }, {
        applySubflow: definition ? (tensor, trace) => subflowCapability(definition, tensor, globals, trace, errors, warnings, nestedSubflowFailures) : undefined,
      });
      globals = new Map([...globals, ...result.bindings.global]);
      recordDiagnostics(result.diagnostics, id, errors, warnings, nestedSubflowFailures);
      for (const suggestion of result.suggestions) {
        if (typeof suggestion.value === "number") suggestions.push({ nodeId: id, param: suggestion.parameter, value: suggestion.value, reason: suggestion.message });
      }
      if (!result.ok || !result.output) continue;
      const outputType = publicTensor(result.output);
      const annotation: NodeTypeAnnotation = { nodeId: id, outputType };
      if (inputs.length === 1) annotation.inputType = publicTensor(inputs[0]);
      if (inputs.length > 1) annotation.inputTypes = inputs.map(publicTensor);
      annotations.set(id, annotation);
      values.set(id, result.output);
    }
    return { ok: !errors.some(error => error.severity === "error"), annotations, errors, warnings, suggestions };
  }
}

function topologicalOrder(nodes: readonly Node[], edges: readonly Edge[]): { order: string[]; cycle: string[]; blocked: string[] } {
  const ids = new Set(nodes.map(node => node.id));
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  const children = new Map(nodes.map(node => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
    children.get(edge.source)!.push(edge.target);
  }
  const queue = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  const result: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    result.push(id);
    for (const child of children.get(id)!) {
      const next = incoming.get(child)! - 1;
      incoming.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  const leftovers = nodes.map(node => node.id).filter(id => !result.includes(id));
  const cycle = cycleMembers(leftovers, children);
  return { order: result, cycle, blocked: leftovers.filter(id => !cycle.includes(id)) };
}

function cycleMembers(ids: readonly string[], children: ReadonlyMap<string, readonly string[]>): string[] {
  const allowed = new Set(ids);
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const members = new Set<string>();
  let next = 0;
  const visit = (id: string): void => {
    index.set(id, next);
    lowlink.set(id, next++);
    stack.push(id);
    onStack.add(id);
    for (const child of children.get(id) ?? []) {
      if (!allowed.has(child)) continue;
      if (!index.has(child)) {
        visit(child);
        lowlink.set(id, Math.min(lowlink.get(id)!, lowlink.get(child)!));
      } else if (onStack.has(child)) {
        lowlink.set(id, Math.min(lowlink.get(id)!, index.get(child)!));
      }
    }
    if (lowlink.get(id) !== index.get(id)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    if (component.length > 1 || (children.get(id) ?? []).includes(id)) component.forEach(value => members.add(value));
  };
  ids.forEach(id => { if (!index.has(id)) visit(id); });
  return ids.filter(id => members.has(id));
}

function normalizedParameters(node: Node, declarations: Readonly<Record<string, { type: string }>>): Record<string, NormalizedParameterValue> {
  const values = (node.data.params ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(declarations).map(([name, declaration]) => {
    const stored = values[name];
    const raw = stored && typeof stored === "object" && "value" in stored ? (stored as { value: unknown }).value : stored;
    return [name, normalizeParameterValue(raw, declaration.type)];
  }));
}

function buildSubflowDefinition(diagram: DiagramCore, container: Node, errors: TypeResult["errors"]): SubflowDefinition | undefined {
  const nodes = diagram.nodes.filter(node => node.parentId === container.id);
  if (nodes.length === 0) return undefined;
  const ids = new Set(nodes.map(node => node.id));
  const edges = diagram.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
  try {
    const graph = describeScopeGraph<SubflowNodeDefinition>(nodes.map(node => {
      const stereotype = diagram.getStereotype(node.data.stereotype as string);
      return {
        id: node.id,
        ...(stereotype?.typeSignature?.inputs.length === 0 ? { boundary: true as const } : {}),
        ...(stereotype?.typeSignature ? { signature: stereotype.typeSignature } : node.type === "subflow" ? { signature: anonymousSubflowSignature } : {}),
        parameters: normalizedParameters(node, stereotype?.parameters ?? {}),
        ...(node.type === "subflow" ? { subflow: buildSubflowDefinition(diagram, node, errors) } : {}),
      };
    }), edges, { isEntry: definition => definition.boundary === true });
    return { graph };
  } catch (error) {
    errors.push({ nodeId: container.id, severity: "error", message: error instanceof Error ? error.message : "invalid subflow graph" });
    return undefined;
  }
}

function subflowCapability(definition: SubflowDefinition, tensor: TensorValue, globals: Map<string, DimensionValue>, trace: readonly string[], errors: TypeResult["errors"], warnings: TypeResult["warnings"], emittedFailures: Set<string>): Evaluation {
  const applied = applySubflow(definition, tensor, { global: globals }, trace);
  for (const [name, value] of applied.bindings.global ?? []) globals.set(name, value);
  if (applied.diagnostics.some(diagnostic => diagnostic.severity === "error")) emittedFailures.add(trace.join("/"));
  for (const diagnostic of applied.diagnostics) {
    if (diagnostic.severity === "warning") {
      warnings.push({ nodeId: diagnostic.nodeId, message: diagnostic.message, kind: warningKind(diagnostic.category) });
    } else {
      errors.push({ nodeId: diagnostic.nodeId, message: diagnostic.message, severity: "error" });
    }
  }
  return applied.value
    ? { kind: "value", value: applied.value, trace }
    : { kind: "error", message: "subflow application failed", trace };
}

function recordDiagnostics(diagnostics: readonly SignatureDiagnostic[], nodeId: string, errors: TypeResult["errors"], warnings: TypeResult["warnings"], emittedFailures: ReadonlySet<string>): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.message === "subflow application failed" && emittedFailures.size > 0) continue;
    if (diagnostic.severity === "warning") warnings.push({ nodeId, message: diagnostic.message, kind: warningKind(diagnostic.category) });
    else errors.push({ nodeId, message: diagnostic.message, severity: "error" });
  }
}

function unknownTensor(): TensorType {
  return { shape: [], dtype: "unknown" };
}

function warningKind(category: string | undefined): TypeResult["warnings"][number]["kind"] {
  return category === "dtype" || category === "perf" || category === "style" ? category : "shape";
}

function publicTensor(tensor: TensorValue): TensorType {
  return { dtype: tensor.dtype, shape: tensor.shape.map(dimension => {
    if (typeof dimension === "number") return { kind: "const", value: dimension };
    if (dimension.tag === "symbol") return { kind: "symbolic", name: dimension.name };
    return { kind: "computed", expr: formatDimension(dimension) };
  }) };
}
