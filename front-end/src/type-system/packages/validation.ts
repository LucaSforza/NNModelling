import { isVersion } from "./semver"
import { isDType, type DType, type Dimension } from "../tensor-type"
import type { Definition, Manifest, PackageKind, ParameterDefinition } from "./types"

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const COLOR = /^#[0-9a-fA-F]{6}$/
const KINDS = new Set<PackageKind>(["input", "layer", "loss", "join", "subflow"])

export function parseManifest(value: unknown): Manifest {
  const object = record(value, "manifest")
  keys(object, ["schemaVersion", "id", "version", "dependencies", "entrypoints"], "manifest")
  if (object.schemaVersion !== 1) fail("manifest schemaVersion must be 1")
  const id = string(object.id, "manifest id")
  if (!ID.test(id)) fail("manifest id is invalid")
  const version = string(object.version, "manifest version")
  if (!isVersion(version)) fail("manifest version is invalid")
  const dependencies = strings(object.dependencies ?? {}, "manifest dependencies")
  for (const [dependency, range] of Object.entries(dependencies)) if (!ID.test(dependency) || !isRange(range)) fail("manifest dependency is invalid")
  const entrypoints = record(object.entrypoints, "manifest entrypoints")
  keys(entrypoints, ["definition", "inference", "pytorch"], "manifest entrypoints")
  return { schemaVersion: 1, id, version, dependencies, entrypoints: {
    definition: path(entrypoints.definition, "definition entrypoint"),
    inference: executable(entrypoints.inference, "lua"),
    pytorch: executable(entrypoints.pytorch, "python"),
  } }
}

export function parseDefinition(value: unknown): Definition {
  const object = record(value, "stereotype definition")
  for (const forbidden of ["id", "version", "dependencies", "entrypoints", "pytorchClass"]) if (forbidden in object) fail(`definition must not contain ${forbidden}`)
  keys(object, ["name", "description", "kind", "view", "parameters"], "stereotype definition")
  const name = string(object.name, "definition name")
  if (!name.trim()) fail("definition name must not be empty")
  const kind = string(object.kind, "definition kind") as PackageKind
  if (!KINDS.has(kind)) fail("definition kind is invalid")
  const viewValue = record(object.view, "definition view")
  keys(viewValue, ["color", "width", "height"], "definition view")
  const view = { color: string(viewValue.color, "view color"), width: integer(viewValue.width, "view width"), height: integer(viewValue.height, "view height") }
  if (!COLOR.test(view.color) || view.width <= 0 || view.height <= 0) fail("definition view is invalid")
  const parameters: Record<string, ParameterDefinition> = {}
  for (const [parameterName, parameterDefinition] of Object.entries(record(object.parameters, "definition parameters"))) {
    if (!parameterName) fail("parameter names must not be empty")
    parameters[parameterName] = parameter(parameterDefinition)
  }
  return { name, description: optionalString(object.description, "definition description"), kind, view, parameters }
}

export function resolveParameters(definitions: Definition["parameters"], supplied: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  for (const key of Object.keys(supplied)) if (!(key in definitions)) fail(`unknown parameter '${key}'`)
  const values: Record<string, unknown> = {}
  for (const [name, definition] of Object.entries(definitions)) {
    const value = supplied[name] === undefined ? definition.default : supplied[name]
    if (value === undefined) fail(`missing required parameter '${name}'`)
    validateValue(definition, value)
    values[name] = structuredClone(value)
  }
  return values
}

function parameter(value: unknown): ParameterDefinition {
  const object = record(value, "parameter")
  const type = string(object.type, "parameter type")
  const position = object.position === undefined ? undefined : positionValue(object.position)
  const base = position === undefined ? {} : { position }
  if (type === "integer" || type === "number") {
    keys(object, ["type", "minimum", "maximum", "default", "position"], "parameter")
    const definition = { type, ...bounds(object), ...base } as ParameterDefinition
    if (object.default !== undefined) validateValue(definition, object.default)
    return object.default === undefined ? definition : { ...definition, default: object.default as number } as ParameterDefinition
  }
  if (type === "boolean") { keys(object, ["type", "default", "position"], "parameter"); return scalar(object, "boolean", base) }
  if (type === "string") {
    keys(object, ["type", "choices", "default", "position"], "parameter")
    const choices = object.choices === undefined ? undefined : array(object.choices, "choices").map(item => string(item, "choice"))
    const definition = { type: "string" as const, choices, ...base }
    if (object.default !== undefined) validateValue(definition, object.default)
    return object.default === undefined ? definition : { ...definition, default: object.default as string }
  }
  if (type === "dtype") {
    keys(object, ["type", "choices", "default", "position"], "parameter")
    const choices = array(object.choices, "dtype choices").map(item => dtype(item, "dtype choice"))
    if (choices.length === 0 || new Set(choices).size !== choices.length) fail("dtype choices must be non-empty and unique")
    const definition = { type: "dtype" as const, choices, ...base }
    if (object.default !== undefined) validateValue(definition, object.default)
    return object.default === undefined ? definition : { ...definition, default: object.default as DType }
  }
  if (type === "shape") {
    keys(object, ["type", "default", "position"], "parameter")
    const definition = { type: "shape" as const, ...base }
    if (object.default !== undefined) validateValue(definition, object.default)
    return object.default === undefined ? definition : { ...definition, default: object.default as readonly Dimension[] }
  }
  if (type === "stereotype") {
    keys(object, ["type", "kind", "default", "position"], "parameter")
    const kind = string(object.kind, "stereotype parameter kind") as PackageKind
    if (!KINDS.has(kind)) fail("stereotype parameter kind is invalid")
    const definition = { type: "stereotype" as const, kind, ...base }
    if (object.default !== undefined) validateValue(definition, object.default)
    return object.default === undefined ? definition : { ...definition, default: object.default as never }
  }
  if (type === "list") {
    keys(object, ["type", "items", "minItems", "maxItems", "default", "position"], "parameter")
    const items = parameter(record(object.items, "list items"))
    if (items.type === "dtype" || items.type === "shape" || items.type === "list" || items.type === "stereotype") fail("list items must be scalar")
    const minItems = object.minItems === undefined ? undefined : nonNegative(object.minItems, "minItems")
    const maxItems = object.maxItems === undefined ? undefined : nonNegative(object.maxItems, "maxItems")
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) fail("minItems must not exceed maxItems")
    const definition = { type: "list" as const, items, minItems, maxItems, ...base }
    if (object.default !== undefined) validateValue(definition, object.default)
    return object.default === undefined ? definition : { ...definition, default: object.default as readonly unknown[] }
  }
  fail("parameter type is invalid")
}

function validateValue(definition: ParameterDefinition, value: unknown): void {
  if (definition.type === "integer" && (!Number.isInteger(value) || !Number.isFinite(value))) fail("parameter must be an integer")
  if (definition.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) fail("parameter must be finite")
  if ((definition.type === "integer" || definition.type === "number") && typeof value === "number") {
    if (definition.minimum !== undefined && value < definition.minimum) fail("parameter is below minimum")
    if (definition.maximum !== undefined && value > definition.maximum) fail("parameter is above maximum")
  }
  if (definition.type === "boolean" && typeof value !== "boolean") fail("parameter must be boolean")
  if (definition.type === "string" && (typeof value !== "string" || (definition.choices && !definition.choices.includes(value)))) fail("parameter string is invalid")
  if (definition.type === "dtype" && (!isDType(value) || !definition.choices.includes(value))) fail("parameter dtype is invalid")
  if (definition.type === "shape" && (!Array.isArray(value) || !value.every(isDimension))) fail("parameter shape is invalid")
  if (definition.type === "list") {
    if (!Array.isArray(value)) fail("parameter must be a list")
    if ((definition.minItems !== undefined && value.length < definition.minItems) || (definition.maxItems !== undefined && value.length > definition.maxItems)) fail("parameter list length is invalid")
    for (const item of value) validateValue(definition.items, item)
  }
  if (definition.type === "stereotype") reference(value)
}

function scalar(object: Record<string, unknown>, type: "boolean", base: object): ParameterDefinition { if (object.default !== undefined && typeof object.default !== "boolean") fail("boolean default is invalid"); return object.default === undefined ? { type, ...base } : { type, default: object.default as boolean, ...base } }
function reference(value: unknown): void { const object = record(value, "stereotype reference"); keys(object, ["id", "version", "parameters"], "stereotype reference"); if (!ID.test(string(object.id, "reference id")) || !isRange(string(object.version, "reference version"))) fail("stereotype reference is invalid"); record(object.parameters, "reference parameters") }
function executable(value: unknown, language: "lua"): { readonly language: "lua"; readonly file: string } | undefined
function executable(value: unknown, language: "python"): { readonly language: "python"; readonly file: string } | undefined
function executable(value: unknown, language: "lua" | "python") { if (value === undefined) return undefined; const object = record(value, "entrypoint"); keys(object, ["language", "file"], "entrypoint"); if (object.language !== language) fail("entrypoint language is invalid"); return { language, file: path(object.file, "entrypoint file") } }
function bounds(object: Record<string, unknown>) { const minimum = object.minimum === undefined ? undefined : finite(object.minimum, "minimum"); const maximum = object.maximum === undefined ? undefined : finite(object.maximum, "maximum"); if (minimum !== undefined && maximum !== undefined && minimum > maximum) fail("minimum must not exceed maximum"); return { minimum, maximum } }
function path(value: unknown, label: string) { const result = string(value, label); if (!result || result.startsWith("/") || result.split(/[\\/]/).includes("..")) fail(`${label} must stay within package`); return result }
function isRange(value: string) { return isVersion(value) || (value.startsWith("^") && isVersion(value.slice(1))) }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`); return value as Record<string, unknown> }
function strings(value: unknown, label: string): Record<string, string> { const object = record(value, label); return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, string(item, label)])) }
function array(value: unknown, label: string): readonly unknown[] { if (!Array.isArray(value)) fail(`${label} must be an array`); return value }
function string(value: unknown, label: string): string { if (typeof value !== "string") fail(`${label} must be a string`); return value }
function dtype(value: unknown, label: string): DType { if (!isDType(value)) fail(`${label} is invalid`); return value }
function isDimension(value: unknown): value is Dimension { return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) }
function optionalString(value: unknown, label: string): string | undefined { return value === undefined ? undefined : string(value, label) }
function finite(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be finite`); return value }
function integer(value: unknown, label: string): number { if (!Number.isInteger(value)) fail(`${label} must be an integer`); return value as number }
function nonNegative(value: unknown, label: string): number { const result = integer(value, label); if (result < 0) fail(`${label} must be non-negative`); return result }
function positionValue(value: unknown): "top" | "bottom" { if (value !== "top" && value !== "bottom") fail("parameter position is invalid"); return value }
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void { const extra = Object.keys(value).find(key => !allowed.includes(key)); if (extra) fail(`${label} has unknown field '${extra}'`) }
function fail(message: string): never { throw new Error(message) }
