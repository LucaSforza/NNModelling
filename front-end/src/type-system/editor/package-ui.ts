import type { ActivePackageMetadata } from "../host"
import type { Definition, ParameterDefinition, PackageKind } from "../packages/types"
import { satisfies } from "../packages/semver"

export type PackageGroupName = "Layers" | "Loss" | "Subflow" | "Join" | "Other"

export type PackageGroup = {
  readonly name: PackageGroupName
  readonly packages: readonly ActivePackageMetadata[]
}

/** UI-only grouping. Semantic inference continues to use definition.kind. */
export function packageGroupName(metadata: ActivePackageMetadata): PackageGroupName {
  const { kind } = metadata.definition
  if (kind === "input" || metadata.definition.name === "Fork" || metadata.definition.name === "Cast") return "Other"
  if (kind === "loss") return "Loss"
  if (kind === "subflow") return "Subflow"
  if (kind === "join") return "Join"
  return "Layers"
}

export function groupedPackages(packages: readonly ActivePackageMetadata[]): PackageGroup[] {
  const order: readonly PackageGroupName[] = ["Layers", "Loss", "Subflow", "Join", "Other"]
  return order.map((name) => ({
    name,
    packages: packages
      .filter((metadata) => packageGroupName(metadata) === name)
      .sort((a, b) => a.definition.name.localeCompare(b.definition.name)),
  })).filter((group) => group.packages.length > 0)
}

export function packageIdentity(metadata: ActivePackageMetadata) {
  return { id: metadata.id, version: metadata.version, name: metadata.definition.name }
}

export function packageMatches(
  metadata: ActivePackageMetadata | undefined,
  identity: { readonly id?: unknown; readonly version?: unknown } | undefined,
): boolean {
  return Boolean(metadata && identity && metadata.id === identity.id && metadata.version === identity.version)
}

/** Resolve a dynamic stereotype reference whose version may be a valid range. */
export function packageReferenceMatches(
  metadata: ActivePackageMetadata | undefined,
  reference: { readonly id?: unknown; readonly version?: unknown } | undefined,
): boolean {
  return Boolean(metadata && reference && metadata.id === reference.id &&
    typeof reference.version === "string" && satisfies(metadata.version, reference.version))
}

/** Defaults are primitive semantic values; required unset values stay absent. */
export function initialPackageParameters(definition: Definition, stored?: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [name, parameter] of Object.entries(definition.parameters)) {
    if (stored && Object.prototype.hasOwnProperty.call(stored, name)) {
      result[name] = structuredClone(stored[name])
    } else if (parameter.default !== undefined) {
      result[name] = structuredClone(parameter.default)
    }
  }
  return result
}

export function parameterValue(
  params: Readonly<Record<string, unknown>> | undefined,
  name: string,
  definition: ParameterDefinition,
): unknown {
  const value = params?.[name]
  if (value !== undefined) return value
  return definition.default
}

export function formatEditorValue(value: unknown, type: ParameterDefinition["type"]): string {
  if (type === "shape" || type === "list") return value === undefined ? "" : JSON.stringify(value)
  if (value === undefined || value === null) return ""
  return String(value)
}

export function parseShapeOrList(raw: string): unknown[] | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
  } catch {
    // Fall through to the compact comma-separated shape notation.
  }
  const values = trimmed.split(",").map((item) => item.trim()).filter(Boolean)
  if (values.length === 0) return undefined
  return values.map((item) => /^-?\d+(\.\d+)?$/.test(item) ? Number(item) : item)
}

export function packageDisplayKind(kind: PackageKind): string {
  return kind[0].toUpperCase() + kind.slice(1)
}
