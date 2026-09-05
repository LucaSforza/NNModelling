import {
  DatasetContractError,
  parseDatasetDefinition,
  type DatasetDefinition,
} from "./dataset-contract"

export type MigratedDatasetDefinition = {
  /** Canonical definition; legacy inference metadata is deliberately absent. */
  readonly definition: DatasetDefinition
  /** Metadata which must be reviewed and moved to a model/package adapter. */
  readonly legacyInferenceAdapter?: Readonly<Record<string, unknown>>
}

/**
 * Remove the transitional dataset-owned adapter field without silently
 * assigning executable behavior to the model. Callers must explicitly map
 * the returned metadata to an existing model/package wheel adapter.
 */
export function migrateDatasetDefinition(value: unknown): MigratedDatasetDefinition {
  const legacyObject = isRecord(value) && Object.prototype.hasOwnProperty.call(value, "inferenceAdapter") ? value : undefined
  const legacyInferenceAdapter = legacyObject?.inferenceAdapter
  if (legacyInferenceAdapter !== undefined && !isRecord(legacyInferenceAdapter)) {
    throw new DatasetContractError("inferenceAdapter must be an object", "invalid-slot", "inferenceAdapter")
  }
  const canonicalValue = legacyObject === undefined
    ? value
    : Object.fromEntries(Object.entries(legacyObject).filter(([key]) => key !== "inferenceAdapter"))
  const parsed = parseDatasetDefinition(canonicalValue)
  return {
    definition: parsed,
    ...(legacyInferenceAdapter === undefined ? {} : { legacyInferenceAdapter }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
