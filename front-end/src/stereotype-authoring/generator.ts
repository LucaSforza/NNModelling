import { parseDefinition, parseManifest } from "../type-system/packages/validation"
import { isVersion } from "../type-system/packages/semver"
import type { Definition, Manifest, PackageKind, ParameterDefinition } from "../type-system/packages/types"
import type { ModelPackageReference } from "../core/types"
import type {
  AuthoringListItemDefinition,
  AuthoringParameterDefinition,
  GeneratedStereotypeResources,
  StereotypeAuthoringRequest,
  ValidatedStereotypeAuthoringRequest,
} from "./types"

const PACKAGE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const COLOR = /^#[0-9a-fA-F]{6}$/
const KINDS = new Set<PackageKind>(["input", "layer", "loss", "join", "subflow", "output"])

/** Validate the complete in-memory authoring request before rendering anything. */
export function validateStereotypeAuthoringRequest(input: StereotypeAuthoringRequest): ValidatedStereotypeAuthoringRequest {
  if (!input || typeof input !== "object") throw new Error("stereotype authoring request must be an object")
  if (!PACKAGE_ID.test(input.id)) throw new Error("stereotype id is invalid")
  if (!isVersion(input.version)) throw new Error("stereotype version is invalid")
  validateDirectory(input.directory)
  if (typeof input.name !== "string" || !input.name.trim()) throw new Error("stereotype name must not be empty")
  if (input.description !== undefined && typeof input.description !== "string") throw new Error("stereotype description must be a string")
  if (!KINDS.has(input.kind)) throw new Error("stereotype kind is invalid")
  if (!input.view || !COLOR.test(input.view.color) || !Number.isInteger(input.view.width) || input.view.width <= 0 || !Number.isInteger(input.view.height) || input.view.height <= 0) {
    throw new Error("stereotype view is invalid")
  }

  const dependencies = normalizeDependencies(input.dependencies)
  if (dependencies[input.id] !== undefined) throw new Error("stereotype cannot depend on itself")
  if (!Array.isArray(input.parameters)) throw new Error("stereotype parameters must be an array")
  const names = new Set<string>()
  const parameters = input.parameters.map((row, index) => {
    if (!row || typeof row !== "object") throw new Error(`parameter ${index} must be an object`)
    if (typeof row.name !== "string" || !row.name.trim()) throw new Error(`parameter ${index} name is invalid`)
    if (names.has(row.name)) throw new Error(`parameter names must be unique: '${row.name}'`)
    names.add(row.name)
    if (!row.definition || typeof row.definition !== "object") throw new Error(`parameter '${row.name}' definition is invalid`)
    if (row.definition.position !== "top" && row.definition.position !== "bottom") throw new Error(`parameter '${row.name}' position is required`)
    // The real package validator owns conditional fields and default validation.
    // Calling it here keeps authoring and runtime acceptance on one schema.
    const normalized = parameterDefinition(row.definition)
    parseDefinition({ name: "Authoring validation", kind: "layer", view: { color: "#000000", width: 1, height: 1 }, parameters: { value: normalized } })
    return structuredClone(row)
  })

  if (input.kind !== "loss" && input.objective !== undefined) throw new Error("only loss stereotypes may declare an objective")

  const objective = input.kind === "loss" && input.objective === undefined
    ? { externalInputs: [{ name: "target", source: "batch.targets" as const }] }
    : input.objective

  return {
    ...structuredClone(input),
    dependencies,
    parameters,
    ...(objective === undefined ? {} : { objective }),
  }
}

/** Render the exact four editable package resources and their model manifest entry. */
export function generateStereotypePackage(input: StereotypeAuthoringRequest): GeneratedStereotypeResources {
  const request = validateStereotypeAuthoringRequest(input)
  const definition = definitionFrom(request)
  const manifest = manifestFrom(request)
  // Re-parse generated JSON-shaped values to prove the output uses the live schema.
  const validatedManifest = parseManifest(manifest)
  const validatedDefinition = parseDefinition(definition)
  const modelPackage: ModelPackageReference = { id: validatedManifest.id, version: validatedManifest.version, path: request.directory }
  const inference = renderLua(request.kind)
  const pytorch = renderPython(request.kind)
  const files = {
    "manifest.json": serialize(validatedManifest),
    "stereotype.json": serialize(validatedDefinition),
    "inference.lua": inference,
    "pytorch.py": pytorch,
  } as const
  return { manifest: validatedManifest, definition: validatedDefinition, modelPackage, files }
}

/** Short alias for callers that treat generation as a create operation. */
export const createStereotypePackage = generateStereotypePackage
export const renderStereotypePackage = generateStereotypePackage

function manifestFrom(request: ValidatedStereotypeAuthoringRequest): Manifest {
  return {
    schemaVersion: 1,
    id: request.id,
    version: request.version,
    dependencies: request.dependencies,
    entrypoints: {
      definition: "stereotype.json",
      inference: { language: "lua", file: "inference.lua" },
      pytorch: { language: "python", file: "pytorch.py" },
    },
  }
}

function definitionFrom(request: ValidatedStereotypeAuthoringRequest): Definition {
  const parameters: Record<string, ParameterDefinition> = {}
  for (const row of [...request.parameters].sort((left, right) => left.name.localeCompare(right.name))) {
    parameters[row.name] = parameterDefinition(row.definition)
  }
  const definition = {
    name: request.name,
    ...(request.description === undefined ? {} : { description: request.description }),
    kind: request.kind,
    ...(request.objective === undefined ? {} : { objective: structuredClone(request.objective) }),
    view: structuredClone(request.view),
    parameters,
  }
  return definition as Definition
}

function parameterDefinition(input: AuthoringParameterDefinition): ParameterDefinition {
  const { position, ...rest } = input
  if (input.type === "list") {
    return { ...rest, items: listItemDefinition(input.items), position } as ParameterDefinition
  }
  return { ...rest, position } as ParameterDefinition
}

function listItemDefinition(input: AuthoringListItemDefinition): Exclude<ParameterDefinition, { type: "dtype" } | { type: "shape" } | { type: "list" } | { type: "stereotype" }> {
  return structuredClone(input) as Exclude<ParameterDefinition, { type: "dtype" } | { type: "shape" } | { type: "list" } | { type: "stereotype" }>
}

function normalizeDependencies(input: StereotypeAuthoringRequest["dependencies"]): Readonly<Record<string, string>> {
  if (input === undefined) return {}
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("stereotype dependencies must be an object")
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([id, range]) => {
    if (!PACKAGE_ID.test(id) || typeof range !== "string" || !isRange(range)) throw new Error("stereotype dependency is invalid")
    return [id, range]
  }))
}

function validateDirectory(directory: string): void {
  if (typeof directory !== "string" || !directory || directory.startsWith("/") || directory.startsWith("\\") || /^[A-Za-z]:/.test(directory) || directory.includes("\\") || /[\u0000-\u001f]/.test(directory)) {
    throw new Error("stereotype directory must be relative")
  }
  const parts = directory.split("/")
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("stereotype directory must be a normalized relative path")
}

function renderLua(kind: PackageKind): string {
  if (kind === "layer") return `-- Model-owned layer scaffold: preserve the incoming tensor exactly.\nreturn function(context, parameters, services)\n  return { status = "success", output = context.inputs[1] }\nend\n`
  return `-- Generated ${kind} scaffold. Its semantics must be implemented by the model author.\nreturn function(context, parameters, services)\n  return { status = "error", message = "Generated ${kind} stereotype is not implemented" }\nend\n`
}

function renderPython(kind: PackageKind): string {
  if (kind === "layer") return `"""Readable model-owned layer scaffold. It is intentionally shape/dtype transparent."""\n\nfrom collections.abc import Mapping\n\nimport torch\n\nfrom stereotype_runtime.pytorch import BuildContext, NoServices\n\nParameters = Mapping[str, object]\n\n\ndef build(\n    parameters: Parameters,\n    context: BuildContext,\n    services: NoServices,\n) -> torch.nn.Module:\n    """Build an identity module; runtime applies it without changing tensors."""\n    del parameters, context, services\n    return torch.nn.Identity()\n`
  return `"""Generated ${kind} scaffold. Implement its runtime contract before use."""\n\nfrom collections.abc import Mapping\n\nimport torch\n\nfrom stereotype_runtime.pytorch import BuildContext, NoServices\n\nParameters = Mapping[str, object]\n\n\ndef build(\n    parameters: Parameters,\n    context: BuildContext,\n    services: NoServices,\n) -> torch.nn.Module:\n    del parameters, context, services\n    raise NotImplementedError("Generated ${kind} stereotype is not implemented")\n`
}

function serialize(value: unknown): string { return `${JSON.stringify(stableValue(value), null, 2)}\n` }
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, stableValue(entry)]))
}
function isRange(value: string): boolean { return isVersion(value) || (value.startsWith("^") && isVersion(value.slice(1))) }
