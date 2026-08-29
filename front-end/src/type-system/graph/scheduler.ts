import type { Node } from "@xyflow/svelte"
import type { TypeContext } from "../type-inference"
import { TypeSystemHost } from "../host"
import { inputsFor, nodeParameters, packageIdentity, type GraphInferenceResult, type GraphNodeResult, type TypeGraphSnapshot } from "./types"

/**
 * Schedules only the current DiagramCore snapshot. It owns no graph state and
 * deliberately leaves nodes whose predecessors are unresolved as editor state.
 */
export class PackageGraphScheduler {
  constructor(private readonly host: TypeSystemHost) {}

  infer(snapshot: TypeGraphSnapshot): GraphInferenceResult {
    const results = new Map<string, GraphNodeResult>()
    const order: string[] = []
    const topLevel = snapshot.nodes.filter((node) => !node.parentId)
    this.inferScope(topLevel, snapshot, results, order)

    const topLevelIds = new Set(topLevel.map((node) => node.id))
    const outgoing = new Set(snapshot.edges
      .filter((edge) => topLevelIds.has(edge.source) && topLevelIds.has(edge.target))
      .map(edge => edge.source))
    const terminals = topLevel.filter(node => !outgoing.has(node.id)).map(node => node.id)
    const roleInfo = this.trainingRoles(snapshot, topLevel, terminals)
    const allResolved = topLevel.every(node => results.get(node.id)?.status === "success")
    const trainingComplete = allResolved && roleInfo.trainingComplete
    const complete = allResolved && (terminals.length === 1 || trainingComplete)
    return {
      nodes: results,
      order,
      terminals,
      complete,
      predictionTerminals: roleInfo.predictionTerminals,
      objectiveTerminals: roleInfo.objectiveTerminals,
      trainingComplete,
      trainingDiagnostics: roleInfo.diagnostics,
    }
  }

  private trainingRoles(snapshot: TypeGraphSnapshot, topLevel: readonly Node[], terminals: readonly string[]) {
    const kindOf = (node: Node): string | undefined => {
      const identity = packageIdentity(node)
      return identity ? this.host.packageDefinition(identity)?.kind : undefined
    }
    const topLevelIds = new Set(topLevel.map(node => node.id))
    const predictionTerminals = terminals.filter(id => kindOf(topLevel.find(node => node.id === id)!) === "output")
    const losses = topLevel.filter(node => kindOf(node) === "loss").map(node => node.id)
    const objectiveIds = new Set(losses)
    const outgoing = new Map<string, string[]>()
    for (const edge of snapshot.edges) {
      if (topLevelIds.has(edge.source) && topLevelIds.has(edge.target)) {
        const targets = outgoing.get(edge.source) ?? []
        targets.push(edge.target)
        outgoing.set(edge.source, targets)
      }
    }
    const pending = [...losses]
    while (pending.length) {
      const source = pending.pop()!
      for (const target of outgoing.get(source) ?? []) {
        if (!objectiveIds.has(target)) { objectiveIds.add(target); pending.push(target) }
      }
    }
    const objectiveTerminals = [...objectiveIds].filter(id => !(outgoing.get(id) ?? []).some(target => objectiveIds.has(target)))
    const diagnostics: string[] = []
    const topInputs = topLevel.filter(node => kindOf(node) === "input")
    const reachable = new Set<string>()
    const reachableQueue = topInputs.map(node => node.id)
    while (reachableQueue.length) {
      const id = reachableQueue.shift()!
      if (reachable.has(id)) continue
      reachable.add(id)
      reachableQueue.push(...(outgoing.get(id) ?? []))
    }
    if (topInputs.length !== 1) diagnostics.push(`training graph requires exactly one top-level input; found ${topInputs.length}`)
    if (predictionTerminals.length !== 1) diagnostics.push(`training graph requires exactly one prediction Output terminal; found ${predictionTerminals.length}`)
    if (objectiveTerminals.length !== 1) diagnostics.push(`training graph requires exactly one objective terminal; found ${objectiveTerminals.length}`)
    for (const node of topLevel) {
      const kind = kindOf(node)
      if (kind === "output" && objectiveIds.has(node.id)) diagnostics.push("prediction Output cannot be inside the objective region")
      if (!reachable.has(node.id)) diagnostics.push(`training graph node '${node.id}' is disconnected from the top-level input`)
    }
    for (const id of objectiveIds) {
      const node = topLevel.find(candidate => candidate.id === id)
      if (node && kindOf(node) === "join" && !(snapshot.edges.some(edge => edge.target === id && topLevelIds.has(edge.source)))) {
        diagnostics.push(`objective join '${id}' has no graph operands`)
      }
    }
    return { predictionTerminals, objectiveTerminals, diagnostics, trainingComplete: diagnostics.length === 0 && losses.length > 0 }
  }

  private inferScope(
    scope: readonly Node[],
    snapshot: TypeGraphSnapshot,
    results: Map<string, GraphNodeResult>,
    order: string[],
    boundaryInput?: import("../tensor-type").TensorType,
  ): GraphNodeResult | undefined {
    const scopeIds = new Set(scope.map((node) => node.id))
    const pending = new Map(scope.map(node => [node.id, node]))
    const incoming = (id: string) => snapshot.edges.filter(edge => edge.target === id && scopeIds.has(edge.source))

    while (pending.size > 0) {
      let progressed = false
      for (const node of pending.values()) {
        const dependencies = incoming(node.id).map(edge => edge.source)
        if (dependencies.some(source => pending.has(source))) continue
        const result = this.inferNode(node, snapshot, results, boundaryInput, scopeIds)
        results.set(node.id, result)
        order.push(node.id)
        pending.delete(node.id)
        progressed = true
      }
      if (!progressed) {
        for (const node of pending.values()) {
          results.set(node.id, { status: "unresolved", reason: "graph contains a cycle" })
          order.push(node.id)
        }
        return { status: "error", message: "subflow graph contains a cycle" }
      }
    }

    const outgoing = new Set(snapshot.edges
      .filter((edge) => scopeIds.has(edge.source) && scopeIds.has(edge.target))
      .map(edge => edge.source))
    const terminals = scope.filter((node) => !outgoing.has(node.id))
    if (terminals.length !== 1) {
      return { status: "error", message: `subflow requires exactly one terminal, got ${terminals.length}` }
    }
    return results.get(terminals[0]!.id) as GraphNodeResult
  }

  private inferNode(
    node: Node,
    snapshot: TypeGraphSnapshot,
    results: ReadonlyMap<string, GraphNodeResult>,
    boundaryInput: import("../tensor-type").TensorType | undefined,
    scopeIds: ReadonlySet<string>,
  ): GraphNodeResult {
    const identity = packageIdentity(node)
    if (!identity) return { status: "unresolved", reason: "node has no versioned package identity" }
    if (!this.host.isActive(identity)) return { status: "unresolved", reason: `package '${identity.id}@${identity.version}' is not active` }
    const definition = this.host.packageDefinition(identity)
    if (!definition) return { status: "unresolved", reason: `package '${identity.id}' has no definition` }

    const nodeEdges = snapshot.edges.filter((edge) => scopeIds.has(edge.source) && scopeIds.has(edge.target))
    let inputs = inputsFor(node.id, nodeEdges, results)
    if (inputs && inputs.length === 0 && boundaryInput && definition.kind !== "input") inputs = [boundaryInput]
    if (!inputs) return { status: "unresolved", reason: "one or more input regions are unresolved" }
    let context: TypeContext
    if (definition.kind === "input") {
      if (inputs.length !== 0) return { status: "error", message: "input package cannot have graph inputs" }
      context = { kind: "input", inputs: [] }
    } else if (definition.kind === "layer" || definition.kind === "loss" || definition.kind === "output") {
      if (inputs.length !== 1) return { status: "unresolved", reason: `package '${identity.id}' requires one graph input` }
      context = { kind: definition.kind, inputs: [inputs[0]!] }
    } else if (definition.kind === "join") {
      if (inputs.length < 2) return { status: "unresolved", reason: `package '${identity.id}' requires two graph inputs` }
      context = { kind: "join", inputs: [inputs[0]!, inputs[1]!, ...inputs.slice(2)] }
    } else {
      context = {
        kind: "subflow",
        inputs: [inputs[0]!],
        inferSubflow: (input) => {
          const children = snapshot.nodes.filter((candidate) => candidate.parentId === node.id)
          if (children.length === 0) return { status: "error", message: "subflow has no child graph" }
          const childOrder: string[] = []
          const childResult = this.inferScope(children, snapshot, results as Map<string, GraphNodeResult>, childOrder, input)
          if (!childResult) return { status: "error", message: "subflow produced no result" }
          if (childResult.status === "success") return childResult
          if (childResult.status === "error") return childResult
          if (childResult.status === "fault") return { status: "error", message: childResult.fault.message }
          if (childResult.status === "unresolved") return {
            status: "error",
            message: "reason" in childResult ? childResult.reason : `missing parameters: ${childResult.missingParameters.join(", ")}`,
          }
          return { status: "error", message: "subflow result is unresolved" }
        },
      }
    }
    return this.host.inferForEditor(identity, context, nodeParameters(node))
  }
}
