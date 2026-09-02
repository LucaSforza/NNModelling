import type { Node } from "@xyflow/svelte"
import type { DatasetDefinition, DatasetTensorContract } from "../../project-workspace/dataset-contract"
import type { PackageIdentity } from "../../core/types"
import type { TensorType } from "../tensor-type"
import type { Definition, PackageExportInfo } from "../packages/types"
import { parseDefinition } from "../packages/validation"
import { packageKey } from "../packages/catalog"
import type { GraphInputBinding, GraphObjectiveBinding, GraphNodeResult } from "./types"
import { packageIdentity } from "./types"

const SLOT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const BATCH_SOURCE = /^batch\.targets\.([A-Za-z_][A-Za-z0-9_]*)$/

export type GraphBindingErrorCode =
  | "invalid-input-binding"
  | "duplicate-input-binding"
  | "missing-input-binding"
  | "missing-dataset-slot"
  | "incompatible-input-shape"
  | "incompatible-input-dtype"
  | "invalid-objective-binding"
  | "missing-objective-slot"

export type GraphBindingDiagnostic = {
  readonly code: GraphBindingErrorCode
  readonly message: string
  readonly nodeId?: string
}

export type CompiledGraphBindings = {
  readonly inputBindings: readonly GraphInputBinding[]
  readonly objectiveBindings: readonly GraphObjectiveBinding[]
  readonly diagnostics: readonly GraphBindingDiagnostic[]
}

type PackageDefinitionResolver = (identity: PackageIdentity) => Definition | undefined

/**
 * Compile the graph's declarative boundary metadata. The function is pure:
 * DiagramCore remains the owner of the source nodes and edges, while this
 * result is a deterministic transport/preflight view.
 */
export function compileGraphBindings(
  nodes: readonly Node[],
  definitions: ReadonlyMap<string, Definition> | PackageDefinitionResolver,
  inference?: ReadonlyMap<string, GraphNodeResult>,
  dataset?: DatasetDefinition,
): CompiledGraphBindings {
  const topLevelInputs = nodes
    .filter((node) => !node.parentId)
    .filter((node) => isKind(node, definitions, "input"))
    .sort(compareNodeId)

  const inputBindings: GraphInputBinding[] = []
  const diagnostics: GraphBindingDiagnostic[] = []
  const usedNames = new Map<string, string>()

  for (const node of topLevelInputs) {
    const raw = inputBindingOf(node)
    const name = raw
    if (name === undefined) {
      diagnostics.push({
        code: "missing-input-binding",
        nodeId: node.id,
        message: `top-level Input node '${node.id}' requires an input binding name`,
      })
      continue
    }
    if (!SLOT_NAME.test(name)) {
      diagnostics.push({
        code: "invalid-input-binding",
        nodeId: node.id,
        message: `input binding '${name}' on node '${node.id}' must be a valid batch slot name`,
      })
      continue
    }
    const previous = usedNames.get(name)
    if (previous !== undefined) {
      diagnostics.push({
        code: "duplicate-input-binding",
        nodeId: node.id,
        message: `input binding '${name}' is used by both '${previous}' and '${node.id}'`,
      })
      continue
    }
    usedNames.set(name, node.id)
    inputBindings.push({ nodeId: node.id, name })

    if (dataset) validateDatasetInput(node, name, inference, dataset, diagnostics)
  }

  inputBindings.sort(compareBinding)

  const objectiveBindings: GraphObjectiveBinding[] = []
  for (const node of nodes.filter((candidate) => !candidate.parentId).sort(compareNodeId)) {
    const identity = packageIdentity(node)
    const definition = identity ? resolveDefinition(definitions, identity) : undefined
    if (!definition || definition.kind !== "loss") continue
    const externalInputs = definition.objective?.externalInputs ?? []
    const usedExternalNames = new Set<string>()
    const normalized = externalInputs.map((binding) => ({
      name: binding.name,
      source: binding.source,
      ...(binding.transform === undefined ? {} : { transform: binding.transform }),
    }))
    for (const binding of normalized) {
      if (!SLOT_NAME.test(binding.name) || usedExternalNames.has(binding.name)) {
        diagnostics.push({
          code: "invalid-objective-binding",
          nodeId: node.id,
          message: `objective binding '${binding.name}' on node '${node.id}' must use a unique valid name`,
        })
        continue
      }
      usedExternalNames.add(binding.name)
      const match = BATCH_SOURCE.exec(binding.source)
      if (!match) {
        diagnostics.push({
          code: "invalid-objective-binding",
          nodeId: node.id,
          message: `objective binding '${binding.name}' on node '${node.id}' has invalid source '${binding.source}'`,
        })
        continue
      }
      const [, slot] = match
      if (dataset && !Object.hasOwn(dataset.batch.targets, slot!)) {
        diagnostics.push({
          code: "missing-objective-slot",
          nodeId: node.id,
          message: `objective binding '${binding.name}' requires missing dataset slot 'batch.targets.${slot}'`,
        })
      }
    }
    objectiveBindings.push({ nodeId: node.id, packageId: identity?.id ?? "", externalInputs: normalized })
  }
  objectiveBindings.sort((left, right) => left.nodeId.localeCompare(right.nodeId))

  return { inputBindings, objectiveBindings, diagnostics }
}

/** Resolve a selected package definition without depending on map iteration order. */
export function packageDefinitionResolver(exports: ReadonlyMap<string, PackageExportInfo>): PackageDefinitionResolver {
  return (identity) => {
    const candidates = [...exports.values()].filter((candidate) => (
      candidate.manifest.id === identity.id && candidate.manifest.version === identity.version
    ))
    if (candidates.length !== 1) return undefined
    const candidate = candidates[0]!
    try {
      return parseDefinition(typeof candidate.definition === "string" ? JSON.parse(candidate.definition) : candidate.definition)
    } catch {
      return undefined
    }
  }
}

function isKind(
  node: Node,
  definitions: ReadonlyMap<string, Definition> | PackageDefinitionResolver,
  kind: Definition["kind"],
): boolean {
  const identity = packageIdentity(node)
  return identity !== undefined && resolveDefinition(definitions, identity)?.kind === kind
}

function resolveDefinition(
  definitions: ReadonlyMap<string, Definition> | PackageDefinitionResolver,
  identity: PackageIdentity,
): Definition | undefined {
  if (typeof definitions === "function") return definitions(identity)
  return definitions.get(packageKey(identity.id, identity.version)) ?? definitions.get(identity.id)
}

function inputBindingOf(node: Node): string | undefined {
  const value = (node.data as { inputBinding?: unknown } | undefined)?.inputBinding
  return typeof value === "string" ? value : undefined
}

function compareBinding(left: GraphInputBinding, right: GraphInputBinding): number {
  return left.name.localeCompare(right.name) || left.nodeId.localeCompare(right.nodeId)
}

function compareNodeId(left: Node, right: Node): number {
  return left.id.localeCompare(right.id)
}

function validateDatasetInput(
  node: Node,
  bindingName: string,
  inference: ReadonlyMap<string, GraphNodeResult> | undefined,
  dataset: DatasetDefinition,
  diagnostics: GraphBindingDiagnostic[],
): void {
  const expected = dataset.batch.inputs[bindingName]
  if (!expected) {
    diagnostics.push({
      code: "missing-dataset-slot",
      nodeId: node.id,
      message: `Input node '${node.id}' binds '${bindingName}', but dataset has no batch.inputs.${bindingName} slot`,
    })
    return
  }
  const result = inference?.get(node.id)
  if (!result || result.status !== "success") return
  if (result.output.dtype !== expected.dtype) {
    diagnostics.push({
      code: "incompatible-input-dtype",
      nodeId: node.id,
      message: `Input binding '${bindingName}' expects dtype '${expected.dtype}' but dataset declares '${result.output.dtype}'`,
    })
  }
  const shapeError = compareShape(result.output, expected)
  if (shapeError) {
    diagnostics.push({
      code: "incompatible-input-shape",
      nodeId: node.id,
      message: `Input binding '${bindingName}' has incompatible shape: ${shapeError}`,
    })
  }
}

function compareShape(actual: TensorType, expected: DatasetTensorContract): string | undefined {
  if (actual.shape.length !== expected.shape.length) return `graph rank ${actual.shape.length}, dataset rank ${expected.shape.length}`
  const variables = new Map<string, string | number>()
  for (let index = 0; index < actual.shape.length; index += 1) {
    const actualDimension = actual.shape[index]!
    const expectedDimension = expected.shape[index]!
    // Batch is a protocol symbol; both sides may use a different spelling for
    // it, but all other symbolic dimensions must map consistently.
    if (index === 0 && (actualDimension === "B" || expectedDimension === "B")) continue
    if (typeof actualDimension === "number") {
      if (typeof expectedDimension === "number" && actualDimension !== expectedDimension) return `dimension ${index} is ${actualDimension}, dataset declares ${expectedDimension}`
      continue
    }
    if (typeof expectedDimension === "number") {
      const previous = variables.get(actualDimension)
      if (previous !== undefined && previous !== expectedDimension) return `symbol '${actualDimension}' is inconsistent`
      variables.set(actualDimension, expectedDimension)
      continue
    }
    const previous = variables.get(actualDimension)
    if (previous !== undefined && previous !== expectedDimension) return `symbol '${actualDimension}' is inconsistent`
    variables.set(actualDimension, expectedDimension)
  }
  return undefined
}
