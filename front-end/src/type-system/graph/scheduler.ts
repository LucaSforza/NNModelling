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
    const pending = new Map(snapshot.nodes.map(node => [node.id, node]))
    const incoming = (id: string) => snapshot.edges.filter(edge => edge.target === id)

    while (pending.size > 0) {
      let progressed = false
      for (const node of pending.values()) {
        const dependencies = incoming(node.id).map(edge => edge.source)
        if (dependencies.some(source => pending.has(source))) continue
        const result = this.inferNode(node, snapshot, results)
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
        break
      }
    }

    const outgoing = new Set(snapshot.edges.map(edge => edge.source))
    const terminals = snapshot.nodes.filter(node => !outgoing.has(node.id)).map(node => node.id)
    return { nodes: results, order, terminals, complete: terminals.length === 1 }
  }

  private inferNode(node: Node, snapshot: TypeGraphSnapshot, results: ReadonlyMap<string, GraphNodeResult>): GraphNodeResult {
    const identity = packageIdentity(node)
    if (!identity) return { status: "unresolved", reason: "node has no versioned package identity" }
    if (!this.host.isActive(identity.id)) return { status: "unresolved", reason: `package '${identity.id}' is not active` }
    const version = this.host.packageVersion(identity.id)
    if (version !== identity.version) return { status: "unresolved", reason: `package '${identity.id}' version '${identity.version}' is not active` }
    const definition = this.host.packageDefinition(identity.id)
    if (!definition) return { status: "unresolved", reason: `package '${identity.id}' has no definition` }

    const inputs = inputsFor(node.id, snapshot.edges, results)
    if (!inputs) return { status: "unresolved", reason: "one or more input regions are unresolved" }
    let context: TypeContext
    if (definition.kind === "input") {
      if (inputs.length !== 0) return { status: "error", message: "input package cannot have graph inputs" }
      context = { kind: "input", inputs: [] }
    } else if (definition.kind === "layer" || definition.kind === "loss") {
      if (inputs.length !== 1) return { status: "unresolved", reason: `package '${identity.id}' requires one graph input` }
      context = { kind: definition.kind, inputs: [inputs[0]!] }
    } else {
      return { status: "unresolved", reason: `package kind '${definition.kind}' is not implemented by T02` }
    }
    return this.host.inferForEditor(identity.id, context, nodeParameters(node))
  }
}
