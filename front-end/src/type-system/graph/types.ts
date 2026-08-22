import type { Edge, Node } from "@xyflow/svelte"
import type { EditorInferenceState } from "../host"
import type { TensorType } from "../tensor-type"
import type { PackageIdentity } from "../../core/types"

export type TypeGraphSnapshot = {
  readonly nodes: readonly Node[]
  readonly edges: readonly Edge[]
}

export type GraphNodeResult = EditorInferenceState | {
  readonly status: "unresolved"
  readonly reason: string
}

export type GraphInferenceResult = {
  readonly nodes: ReadonlyMap<string, GraphNodeResult>
  readonly order: readonly string[]
  readonly terminals: readonly string[]
  readonly complete: boolean
}

export type PackageNodeData = {
  readonly package?: PackageIdentity
  readonly params?: Readonly<Record<string, unknown>>
}

export function packageIdentity(node: Node): PackageIdentity | undefined {
  const data = node.data as PackageNodeData | undefined
  const candidate = data?.package
  if (!candidate || typeof candidate !== "object") return undefined
  if (typeof candidate.id !== "string" || typeof candidate.version !== "string" || typeof candidate.name !== "string") return undefined
  return { id: candidate.id, version: candidate.version, name: candidate.name }
}

export function nodeParameters(node: Node): Readonly<Record<string, unknown>> {
  const params = (node.data as PackageNodeData | undefined)?.params
  return params && typeof params === "object" && !Array.isArray(params) ? params : {}
}

export function inputsFor(nodeId: string, edges: readonly Edge[], results: ReadonlyMap<string, GraphNodeResult>): TensorType[] | undefined {
  const incoming = edges
    .filter(edge => edge.target === nodeId)
    .sort((left, right) => (left.targetHandle ?? "in") .localeCompare(right.targetHandle ?? "in"))
  const tensors: TensorType[] = []
  for (const edge of incoming) {
    const result = results.get(edge.source)
    if (!result || result.status !== "success") return undefined
    tensors.push(result.output)
  }
  return tensors
}
