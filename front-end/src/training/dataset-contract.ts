import { parseDatasetReference, type DatasetDefinition, type DatasetReference } from "../project-workspace/dataset-contract"

export type { DatasetDefinition, DatasetReference }

/** Training selection contains an opaque resolved dataset handle, never a Python target. */
export type DatasetSelection = {
  readonly reference: DatasetReference
  readonly parameters: Readonly<Record<string, string | number | boolean>>
}

export function validateDatasetSelection(value: unknown): DatasetSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("dataset selection must be an object")
  const object = value as Record<string, unknown>
  const reference = parseDatasetReference(object.reference)
  const parameters = object.parameters
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("dataset selection parameters must be an object")
  const normalized: Record<string, string | number | boolean> = {}
  for (const [name, parameter] of Object.entries(parameters as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`dataset selection parameter '${name}' is invalid`)
    if (typeof parameter !== "string" && typeof parameter !== "number" && typeof parameter !== "boolean") throw new Error(`dataset selection parameter '${name}' must be scalar`)
    if (typeof parameter === "number" && !Number.isFinite(parameter)) throw new Error(`dataset selection parameter '${name}' must be finite`)
    normalized[name] = parameter
  }
  return { reference, parameters: normalized }
}

