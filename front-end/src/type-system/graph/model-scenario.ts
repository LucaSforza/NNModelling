import type { Edge, Node } from "@xyflow/svelte"
import type { ActivePackageMetadata } from "../host"
import type { DatasetInferenceContext } from "./types"

export type SemanticModelScenario = {
  readonly modelId: string
  readonly dataset?: { readonly inputs: Readonly<Record<string, { readonly shape: readonly import("../tensor-type").Dimension[]; readonly dtype: import("../tensor-type").DType }>> }
  readonly nodes: readonly {
    readonly id: string
    readonly packageId: string
    readonly parameters: Readonly<Record<string, unknown>>
    readonly inputs: readonly string[]
  }[]
}

export type ScenarioSnapshot = {
  nodes: Node[]
  edges: Edge[]
  layoutDirection: "vertical"
  datasetContext?: DatasetInferenceContext
}

/** Translate semantic test scenarios into the same persisted nodes used by DiagramCore. */
export function scenarioSnapshot(
  scenario: SemanticModelScenario,
  packages: readonly ActivePackageMetadata[],
): ScenarioSnapshot {
  const selected = new Map(packages.map(metadata => [metadata.id, metadata]))
  const nodes = scenario.nodes.map((modelNode, index): Node => {
    const metadata = selected.get(modelNode.packageId)
    if (!metadata) throw new Error(`scenario '${scenario.modelId}' uses unavailable package '${modelNode.packageId}'`)
    return {
      id: modelNode.id,
      type: metadata.definition.kind === "join" ? "join" : "custom",
      position: { x: 120 + (index % 3) * 260, y: 60 + index * 140 },
      width: metadata.definition.kind === "input" ? 30 : metadata.definition.view.width,
      height: metadata.definition.kind === "input" ? 30 : metadata.definition.view.height,
      data: {
        package: { id: metadata.id, version: metadata.version, name: metadata.definition.name },
        name: modelNode.id,
        color: metadata.definition.view.color,
        params: metadata.definition.kind === "input" ? {} : structuredClone(modelNode.parameters),
        ...(metadata.definition.kind === "input" ? { inputBinding: modelNode.id } : {}),
        ...(metadata.definition.kind === "join" ? { inputsCount: modelNode.inputs.length } : {}),
      },
    }
  })
  const edges = scenario.nodes.flatMap(modelNode => modelNode.inputs.map((source, inputIndex): Edge => ({
    id: `${source}-${modelNode.id}-${inputIndex}`,
    source,
    target: modelNode.id,
    sourceHandle: "out",
    targetHandle: modelNode.inputs.length > 1 ? `in-${inputIndex}` : "in",
    type: "editable",
    data: { route: { points: [] } },
  })))
  const input = scenario.nodes.find((node) => {
    const metadata = selected.get(node.packageId)
    return metadata?.definition.kind === "input"
  })
  const inputBinding = input?.id ?? "input"
  const datasetTensor = scenario.dataset?.inputs[inputBinding]
  const inputShape = datasetTensor?.shape ?? input?.parameters.shape
  const inputDtype = datasetTensor?.dtype ?? input?.parameters.dtype
  const symbols = Array.isArray(inputShape)
    ? [...new Set(inputShape.filter((dimension): dimension is string => typeof dimension === "string"))]
    : []
  const datasetParameters = Object.fromEntries(symbols.map((symbol) => [symbol, 1]))
  const datasetContext = Array.isArray(inputShape) && typeof inputDtype === "string"
    ? {
        definition: {
          schemaVersion: 1 as const,
          id: `${scenario.modelId}.dataset`,
          version: "0.1.0",
          name: `${scenario.modelId} dataset`,
          parameters: symbols.map((name) => ({ name, type: "integer" as const, required: true })),
          batch: { inputs: { [input?.id ?? "input"]: { shape: inputShape as readonly import("../tensor-type").Dimension[], dtype: inputDtype as import("../tensor-type").DType } }, targets: {} },
        },
        parameters: datasetParameters,
      }
    : undefined
  return { nodes, edges, layoutDirection: "vertical", ...(datasetContext ? { datasetContext } : {}) }
}
