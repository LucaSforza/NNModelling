import { isVersion } from "../type-system/packages/semver"
import { isDType, type DType, type Dimension } from "../type-system/tensor-type"

/** Versioned source metadata for a project-owned dataset. */
export const DATASET_SCHEMA_VERSION = 1 as const
export const MODEL_MANIFEST_SCHEMA_VERSION = 2 as const

export type DatasetContractErrorCode =
  | "unknown-version"
  | "unknown-field"
  | "invalid-identity"
  | "invalid-path"
  | "duplicate-entry"
  | "invalid-parameter"
  | "invalid-slot"
  | "unsupported-dtype"
  | "invalid-reference"

export class DatasetContractError extends Error {
  constructor(
    message: string,
    readonly code: DatasetContractErrorCode,
    readonly path?: string,
  ) {
    super(`${code}${path ? ` at ${path}` : ""}: ${message}`)
    this.name = "DatasetContractError"
  }
}

export type ModelDatasetReference = {
  readonly id: string
  readonly version: string
  readonly path: string
}

export type ModelPackageReference = {
  readonly id: string
  readonly version: string
  readonly path: string
}

export type ModelManifestV2 = {
  readonly schemaVersion: 2
  readonly id: string
  readonly version: string
  readonly name: string
  readonly description?: string
  readonly customPackages: readonly ModelPackageReference[]
  readonly customDatasets: readonly ModelDatasetReference[]
}

export type ParsedModelManifest = {
  readonly manifest: ModelManifestV2
}

export type DatasetParameterType = "string" | "integer" | "number" | "boolean"
export type DatasetParameterValue = string | number | boolean

export type DatasetParameter = {
  readonly name: string
  readonly type: DatasetParameterType
  readonly required: boolean
  readonly default?: DatasetParameterValue
}

export type DatasetTensorContract = {
  readonly shape: readonly Dimension[]
  readonly dtype: DType
}

export type DatasetBatchContract = {
  readonly inputs: Readonly<Record<string, DatasetTensorContract>>
  readonly targets: Readonly<Record<string, DatasetTensorContract>>
}

export type DatasetClassMetadata = {
  readonly count: number
  readonly names?: readonly string[]
}

export type DatasetDefinition = {
  readonly schemaVersion: 1
  readonly id: string
  readonly version: string
  readonly name: string
  readonly description?: string
  readonly parameters: readonly DatasetParameter[]
  readonly batch: DatasetBatchContract
  readonly classes?: DatasetClassMetadata
  readonly inferenceAdapter?: Readonly<Record<string, unknown>>
}

export type DatasetSourceManifest = {
  readonly schemaVersion: 1
  readonly id: string
  readonly version: string
  readonly entrypoints: {
    readonly definition: "dataset.json"
    readonly python: "dataset.py"
  }
}

export type DatasetReference = {
  readonly kind: "project"
  readonly id: string
  readonly version: string
  /** Server-issued opaque handle; never a Python import target or filesystem path. */
  readonly ref: string
  readonly digest?: string
}

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SLOT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const DIMENSION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SHA256 = /^[0-9a-f]{64}$/i

export function parseModelManifest(value: unknown): ParsedModelManifest {
  const object = record(value, "model manifest")
  const schemaVersion = object.schemaVersion
  let normalized: Record<string, unknown>
  if (schemaVersion === 1) {
    assertKnownKeys(object, ["schemaVersion", "id", "version", "name", "description", "customPackages"], "model manifest")
    normalized = { ...object, schemaVersion: MODEL_MANIFEST_SCHEMA_VERSION, customDatasets: [] }
  } else if (schemaVersion === MODEL_MANIFEST_SCHEMA_VERSION) {
    normalized = object
  } else {
    fail("model manifest schemaVersion is unsupported", "unknown-version", "schemaVersion")
  }

  const allowed = ["schemaVersion", "id", "version", "name", "description", "customPackages", "customDatasets"]
  assertKnownKeys(normalized, allowed, "model manifest")
  const id = identity(normalized.id, "model manifest id")
  const version = versionOf(normalized.version, "model manifest version")
  const name = nonEmptyString(normalized.name, "model manifest name")
  const description = normalized.description === undefined ? undefined : nonEmptyString(normalized.description, "model manifest description")
  const customPackages = parseModelEntries(normalized.customPackages, "customPackages")
  const customDatasets = parseModelEntries(normalized.customDatasets, "customDatasets")
  return {
    manifest: {
      schemaVersion: MODEL_MANIFEST_SCHEMA_VERSION,
      id,
      version,
      name,
      ...(description === undefined ? {} : { description }),
      customPackages,
      customDatasets,
    },
  }
}

export function upgradeModelManifest(value: unknown): ModelManifestV2 {
  return parseModelManifest(value).manifest
}

export function parseDatasetDefinition(value: unknown): DatasetDefinition {
  const object = record(value, "dataset definition")
  assertKnownKeys(object, ["schemaVersion", "id", "version", "name", "description", "parameters", "batch", "classes", "inferenceAdapter"], "dataset definition")
  if (object.schemaVersion !== DATASET_SCHEMA_VERSION) fail("dataset definition schemaVersion is unsupported", "unknown-version", "schemaVersion")
  const id = identity(object.id, "dataset definition id")
  const version = versionOf(object.version, "dataset definition version")
  const name = nonEmptyString(object.name, "dataset definition name")
  const description = object.description === undefined ? undefined : nonEmptyString(object.description, "dataset definition description")
  if (!Array.isArray(object.parameters)) fail("parameters must be an array", "invalid-parameter", "parameters")
  const parameterNames = new Set<string>()
  const parameters = object.parameters.map((item, index) => {
    const parameter = record(item, `parameters[${index}]`)
    assertKnownKeys(parameter, ["name", "type", "required", "default"], `parameters[${index}]`)
    const parameterName = identifier(parameter.name, `parameters[${index}].name`, "invalid-parameter")
    if (parameterNames.has(parameterName)) fail(`duplicate parameter '${parameterName}'`, "duplicate-entry", `parameters[${index}].name`)
    parameterNames.add(parameterName)
    const type = parameter.type
    if (type !== "string" && type !== "integer" && type !== "number" && type !== "boolean") fail("parameter type is unsupported", "invalid-parameter", `parameters[${index}].type`)
    const parameterType: DatasetParameterType = type
    const required = parameter.required
    if (typeof required !== "boolean") fail("required must be a boolean", "invalid-parameter", `parameters[${index}].required`)
    const defaultValue = parameter.default === undefined ? undefined : scalar(parameter.default, `parameters[${index}].default`)
    if (defaultValue !== undefined && !parameterValueMatches(parameterType, defaultValue)) fail("default does not match parameter type", "invalid-parameter", `parameters[${index}].default`)
    if (required && defaultValue !== undefined) fail("required parameters cannot have a default", "invalid-parameter", `parameters[${index}]`)
    return { name: parameterName, type: parameterType, required, ...(defaultValue === undefined ? {} : { default: defaultValue }) }
  })
  const batchObject = record(object.batch, "batch")
  assertKnownKeys(batchObject, ["inputs", "targets"], "batch")
  const inputs = parseSlots(batchObject.inputs, "batch.inputs")
  const targets = parseSlots(batchObject.targets, "batch.targets")
  const names = new Set(Object.keys(inputs))
  for (const name of Object.keys(targets)) {
    if (names.has(name)) fail(`duplicate slot '${name}'`, "duplicate-entry", "batch")
    names.add(name)
  }
  const classes = object.classes === undefined ? undefined : parseClasses(object.classes)
  const inferenceAdapter = object.inferenceAdapter === undefined ? undefined : record(object.inferenceAdapter, "inferenceAdapter")
  return {
    schemaVersion: DATASET_SCHEMA_VERSION,
    id,
    version,
    name,
    ...(description === undefined ? {} : { description }),
    parameters,
    batch: { inputs, targets },
    ...(classes === undefined ? {} : { classes }),
    ...(inferenceAdapter === undefined ? {} : { inferenceAdapter }),
  }
}

export function parseDatasetSourceManifest(value: unknown): DatasetSourceManifest {
  const object = record(value, "dataset manifest")
  assertKnownKeys(object, ["schemaVersion", "id", "version", "entrypoints"], "dataset manifest")
  if (object.schemaVersion !== DATASET_SCHEMA_VERSION) fail("dataset manifest schemaVersion is unsupported", "unknown-version", "schemaVersion")
  const id = identity(object.id, "dataset manifest id")
  const version = versionOf(object.version, "dataset manifest version")
  const entrypoints = record(object.entrypoints, "dataset manifest entrypoints")
  assertKnownKeys(entrypoints, ["definition", "python"], "dataset manifest entrypoints")
  if (entrypoints.definition !== "dataset.json" || entrypoints.python !== "dataset.py") fail("dataset entrypoints must be dataset.json and dataset.py", "invalid-path", "entrypoints")
  return { schemaVersion: DATASET_SCHEMA_VERSION, id, version, entrypoints: { definition: "dataset.json", python: "dataset.py" } }
}

export function parseDatasetReference(value: unknown): DatasetReference {
  const object = record(value, "dataset reference")
  assertKnownKeys(object, ["kind", "id", "version", "ref", "digest"], "dataset reference")
  if (object.kind !== "project") fail("kind must be project", "invalid-reference", "kind")
  const id = identity(object.id, "dataset reference id")
  const version = versionOf(object.version, "dataset reference version")
  const ref = nonEmptyString(object.ref, "dataset reference ref")
  if (ref.includes("/") || ref.includes("\\") || ref.startsWith(".")) fail("ref must be opaque and not a path", "invalid-reference", "ref")
  const digest = object.digest === undefined ? undefined : nonEmptyString(object.digest, "dataset reference digest")
  if (digest !== undefined && !SHA256.test(digest)) fail("digest must be a SHA-256 hex string", "invalid-reference", "digest")
  if (digest === undefined) fail("project references require a digest", "invalid-reference", "digest")
  return { kind: object.kind, id, version, ref, ...(digest === undefined ? {} : { digest: digest.toLowerCase() }) }
}

export function serializeDatasetDefinition(value: DatasetDefinition): string {
  return JSON.stringify(sortKeys(value))
}

function parseModelEntries(value: unknown, label: string): ModelDatasetReference[] {
  if (!Array.isArray(value)) fail("must be an array", "invalid-identity", label)
  const identities = new Set<string>()
  const paths = new Set<string>()
  return value.map((item, index) => {
    const object = record(item, `${label}[${index}]`)
    assertKnownKeys(object, ["id", "version", "path"], `${label}[${index}]`)
    const id = identity(object.id, `${label}[${index}].id`)
    const version = versionOf(object.version, `${label}[${index}].version`)
    const path = relativePath(object.path, `${label}[${index}].path`)
    const identityKey = `${id}@${version}`
    if (identities.has(identityKey) || paths.has(path)) fail(`duplicate entry '${identityKey}' or path '${path}'`, "duplicate-entry", label)
    identities.add(identityKey)
    paths.add(path)
    return { id, version, path }
  })
}

function parseSlots(value: unknown, label: string): Record<string, DatasetTensorContract> {
  const object = record(value, label)
  const result: Record<string, DatasetTensorContract> = {}
  for (const name of Object.keys(object).sort()) {
    if (!SLOT_NAME.test(name)) fail("slot name is invalid", "invalid-slot", `${label}.${name}`)
    result[name] = parseTensor(object[name], `${label}.${name}`)
  }
  return result
}

function parseTensor(value: unknown, label: string): DatasetTensorContract {
  const object = record(value, label)
  assertKnownKeys(object, ["shape", "dtype"], label)
  if (!Array.isArray(object.shape) || !object.shape.every(isDimensionContract)) fail("shape must contain positive dimensions or symbols", "invalid-slot", `${label}.shape`)
  if (!isDType(object.dtype)) fail("dtype is unsupported", "unsupported-dtype", `${label}.dtype`)
  return { shape: object.shape as Dimension[], dtype: object.dtype }
}

function parseClasses(value: unknown): DatasetClassMetadata {
  const object = record(value, "classes")
  assertKnownKeys(object, ["count", "names"], "classes")
  if (typeof object.count !== "number" || !Number.isInteger(object.count) || object.count < 1) fail("count must be a positive integer", "invalid-parameter", "classes.count")
  const count = object.count
  if (object.names !== undefined && (!Array.isArray(object.names) || object.names.length !== count || !object.names.every((name) => typeof name === "string" && Boolean(name)))) fail("names must contain one non-empty label per class", "invalid-parameter", "classes.names")
  return { count, ...(object.names === undefined ? {} : { names: object.names as string[] }) }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be an object", "invalid-identity", label)
  return value as Record<string, unknown>
}

function assertKnownKeys(object: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(object).find((key) => !allowed.includes(key))
  if (extra) fail(`unknown field '${extra}'`, "unknown-field", `${label}.${extra}`)
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail("must be a non-empty string", "invalid-identity", label)
  return value
}

function identity(value: unknown, label: string): string {
  const result = nonEmptyString(value, label)
  if (!ID.test(result)) fail("contains unsupported characters", "invalid-identity", label)
  return result
}

function versionOf(value: unknown, label: string): string {
  const result = nonEmptyString(value, label)
  if (!isVersion(result)) fail("is not a valid semantic version", "invalid-identity", label)
  return result
}

function relativePath(value: unknown, label: string): string {
  const path = nonEmptyString(value, label).replaceAll("\\", "/")
  const segments = path.split("/")
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.includes("\0") || segments.some((segment) => !segment || segment === "." || segment === "..")) fail("must be a confined relative path", "invalid-path", label)
  return path
}

function identifier(value: unknown, label: string, code: DatasetContractErrorCode): string {
  const result = nonEmptyString(value, label)
  if (!PARAMETER_NAME.test(result)) fail("is not a valid identifier", code, label)
  return result
}

function scalar(value: unknown, label: string): DatasetParameterValue {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") fail("must be a scalar value", "invalid-parameter", label)
  if (typeof value === "number" && !Number.isFinite(value)) fail("must be finite", "invalid-parameter", label)
  return value
}

function parameterValueMatches(type: DatasetParameterType, value: DatasetParameterValue): boolean {
  return type === "string" ? typeof value === "string" : type === "integer" ? typeof value === "number" && Number.isInteger(value) : type === "number" ? typeof value === "number" : typeof value === "boolean"
}

function isDimensionContract(value: unknown): value is Dimension {
  return (typeof value === "number" && Number.isInteger(value) && value > 0) || (typeof value === "string" && DIMENSION_NAME.test(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortKeys(entry)]))
}

function fail(message: string, code: DatasetContractErrorCode, path?: string): never {
  throw new DatasetContractError(message, code, path)
}
