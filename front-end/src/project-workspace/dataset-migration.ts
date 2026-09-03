import type { Node } from "@xyflow/svelte"

import {
  DatasetContractError,
  parseDatasetDefinition,
  type DatasetDefinition,
} from "./dataset-contract"
import { isDType, type Dimension } from "../type-system/tensor-type"

const INPUT_ID = "core.input"
const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/

export type MigratedDatasetDefinition = {
  /** Canonical definition; legacy inference metadata is deliberately absent. */
  readonly definition: Omit<DatasetDefinition, "inferenceAdapter">
  /** Metadata which must be reviewed and moved to a model/package adapter. */
  readonly legacyInferenceAdapter?: Readonly<Record<string, unknown>>
}

/**
 * Remove the transitional dataset-owned adapter field without silently
 * assigning executable behavior to the model. Callers must explicitly map
 * the returned metadata to an existing model/package wheel adapter.
 */
export function migrateDatasetDefinition(value: unknown): MigratedDatasetDefinition {
  const parsed = parseDatasetDefinition(value)
  const { inferenceAdapter, ...definition } = parsed
  return {
    definition,
    ...(inferenceAdapter === undefined ? {} : { legacyInferenceAdapter: inferenceAdapter }),
  }
}

/**
 * Strip legacy shape/dtype values from top-level Input nodes. Internal Inputs
 * are graph composition boundaries and are intentionally left untouched.
 * Legacy values are validated before removal so malformed or ambiguous
 * projects fail instead of being guessed into the new named contract.
 */
export function migrateLegacyInputNodes(nodes: readonly Node[]): readonly Node[] {
  return nodes.map((node) => {
    if (node.parentId != null || packageIdOf(node) !== INPUT_ID) return node
    const data = (node.data ?? {}) as Record<string, unknown>
    const binding = data.inputBinding
    const params = data.params
    const hasShape = isRecord(params) && Object.prototype.hasOwnProperty.call(params, "shape")
    const hasDtype = isRecord(params) && Object.prototype.hasOwnProperty.call(params, "dtype")
    if (binding === undefined && (hasShape || hasDtype)) {
      throw migrationError("legacy top-level Input requires a named inputBinding", `${node.id}.data.inputBinding`)
    }
    if (binding !== undefined && (typeof binding !== "string" || !BINDING.test(binding))) {
      throw migrationError("inputBinding must be a valid named dataset slot", `${node.id}.data.inputBinding`)
    }
    if (!hasShape && !hasDtype) return node
    if (!hasShape || !hasDtype) {
      throw migrationError("legacy Input shape and dtype must be provided together", `${node.id}.data.params`)
    }
    const shape = (params as Record<string, unknown>).shape
    const dtype = (params as Record<string, unknown>).dtype
    if (!isShape(shape) || !isDType(dtype)) {
      throw migrationError("legacy Input shape or dtype is malformed", `${node.id}.data.params`)
    }
    const extra = Object.keys(params as Record<string, unknown>).filter((key) => key !== "shape" && key !== "dtype")
    if (extra.length > 0) {
      throw migrationError(`legacy Input contains unsupported parameters: ${extra.join(", ")}`, `${node.id}.data.params`)
    }
    const nextData = { ...data }
    delete nextData.params
    return { ...node, data: nextData }
  })
}

function packageIdOf(node: Node): string | undefined {
  const packageValue = (node.data as { package?: unknown } | undefined)?.package
  if (!isRecord(packageValue) || typeof packageValue.id !== "string") return undefined
  return packageValue.id
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isShape(value: unknown): value is readonly Dimension[] {
  return Array.isArray(value) && value.every((dimension) =>
    (typeof dimension === "number" && Number.isInteger(dimension) && dimension > 0) ||
    (typeof dimension === "string" && BINDING.test(dimension)),
  )
}

function migrationError(message: string, path: string): DatasetContractError {
  return new DatasetContractError(message, "invalid-slot", path)
}
