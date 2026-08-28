import type { Edge, Node } from "@xyflow/svelte"
import type { ActivePackageMetadata } from "../host"

export type SemanticModelScenario = {
  readonly modelId: string
  readonly nodes: readonly {
    readonly id: string
    readonly packageId: string
    readonly parameters: Readonly<Record<string, unknown>>
    readonly inputs: readonly string[]
  }[]
}

/** Translate semantic test scenarios into the same persisted nodes used by DiagramCore. */
export function scenarioSnapshot(
  scenario: SemanticModelScenario,
  packages: readonly ActivePackageMetadata[],
): { nodes: Node[]; edges: Edge[]; layoutDirection: "vertical" } {
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
        params: structuredClone(modelNode.parameters),
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
  return { nodes, edges, layoutDirection: "vertical" }
}
