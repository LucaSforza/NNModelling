import type { Edge, Node } from "@xyflow/svelte"
import type { PackageExportInfo, WheelAdapterValueSchema } from "../type-system/packages/types"
import type { PackageIdentity, PersistedPackageIdentity } from "../core/types"
import { parseDefinition } from "../type-system/packages/validation"
import type { GraphInferenceResult } from "../type-system/graph/types"
import type { GraphInputBinding, GraphObjectiveBinding } from "../type-system/graph/types"
import { compileGraphBindings, packageDefinitionResolver, type CompiledGraphBindings } from "../type-system/graph/bindings"
import type { DatasetDefinition } from "../project-workspace/dataset-contract"
import { packageKey } from "../type-system/packages/catalog"
import { satisfies } from "../type-system/packages/semver"

export type PackageBundleGraph = {
  /** Deterministic named model inputs, sorted by slot then node ID. */
  readonly inputBindings: readonly GraphInputBinding[]
  /** Loss package declarations copied into the executable graph boundary. */
  readonly objectiveBindings: readonly GraphObjectiveBinding[]
  readonly nodes: readonly {
    readonly id: string
    readonly type: string
    readonly package: PersistedPackageIdentity
    readonly params: Readonly<Record<string, unknown>>
    readonly wheelAdapters: readonly PackageBundleAdapterBinding[]
    readonly parentId: string | null
    readonly inputBinding?: string
  }[]
  readonly edges: readonly {
    readonly id: string
    readonly source: string
    readonly target: string
    readonly sourceHandle: string | null
    readonly targetHandle: string | null
  }[]
}

export type PackageBundleAdapterBinding = {
  readonly name: string
  readonly input: WheelAdapterValueSchema
  readonly output: WheelAdapterValueSchema
}

export type PackageBundleFile = {
  readonly path: string
  readonly content: string
  readonly size: number
  readonly sha256: string
}

export type PackageBundlePackage = {
  readonly id: string
  readonly version: string
  readonly dependencies: Readonly<Record<string, string>>
  /** Exact dependency identities selected for this bundle. */
  readonly resolvedDependencies: Readonly<Record<string, string>>
  readonly manifest: PackageExportInfo["manifest"]
  readonly files: Readonly<Record<string, PackageBundleFile>>
}

export type PackageBundleV1 = {
  readonly schema_version: 1
  readonly format: "package-bundle/v1"
  readonly runtime: { readonly name: "stereotype_runtime.pytorch"; readonly version: 1 }
  readonly graph: PackageBundleGraph
  readonly packages: readonly PackageBundlePackage[]
  readonly digest: string
}

type PackageNode = Node & { data?: { package?: PackageIdentity; params?: Record<string, unknown>; wheelAdapters?: readonly string[]; inputBinding?: string } }
type SemanticGraph = Omit<PackageBundleGraph, "nodes" | "inputBindings" | "objectiveBindings"> & {
  readonly nodes: readonly (Omit<PackageBundleGraph["nodes"][number], "wheelAdapters"> & { readonly wheelAdapters: readonly string[] })[]
}

/** Build the content-addressed, semantic package transport without running Python. */
export async function buildPackageBundle(
  nodes: readonly Node[],
  edges: readonly Edge[],
  exports: ReadonlyMap<string, PackageExportInfo>,
  inference?: GraphInferenceResult | null,
  dataset?: DatasetDefinition,
): Promise<PackageBundleV1> {
  const graphDraft = semanticGraph(nodes, edges)
  const selected = new Map<string, PackageExportInfo>()
  const selectedKeys = new Map<string, string>()
  const visit = (identity: PersistedPackageIdentity): void => {
    const key = packageKey(identity.id, identity.version)
    const currentKey = selectedKeys.get(identity.id)
    if (currentKey) {
      if (currentKey !== key) throw new Error(`package '${identity.id}' has conflicting versions in graph`)
      return
    }
    const packageInfo = exactExport(exports, identity)
    assertUsable(packageInfo, key)
    selectedKeys.set(identity.id, key)
    selected.set(key, packageInfo)
    for (const dependency of Object.keys(packageInfo.manifest.dependencies).sort()) {
      const dependencyKey = resolveDependency(exports, packageInfo, key, dependency)
      visit(packageDiagnosticIdentity(dependencyKey))
    }
  }
  for (const node of graphDraft.nodes) visit(node.package)
  const bindings = compileGraphBindings(nodes, packageDefinitionResolver(exports), inference?.nodes, dataset)
  if (bindings.diagnostics.length > 0) {
    throw new Error(bindings.diagnostics.map((diagnostic) => diagnostic.message).join("; "))
  }
  const graph = materializeGraph(graphDraft, selected, inference, bindings)

  const packages = await Promise.all([...selected.values()]
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
    .map(async (packageInfo) => {
      const files = await packageFiles(packageInfo)
      return {
        id: packageInfo.manifest.id,
        version: packageInfo.manifest.version,
        dependencies: packageInfo.manifest.dependencies,
        resolvedDependencies: packageInfo.resolvedDependencies ?? resolveDependencyMap(exports, packageInfo, packageKey(packageInfo.manifest.id, packageInfo.manifest.version)),
        manifest: packageInfo.manifest,
        files: Object.fromEntries(files.map((entry) => [entry.path, entry])),
      }
    }))
  const payload = {
    schema_version: 1 as const,
    format: "package-bundle/v1" as const,
    runtime: { name: "stereotype_runtime.pytorch" as const, version: 1 as const },
    graph,
    packages,
  }
  return { ...payload, digest: await sha256(canonicalJson(payload)) }
}

function materializeGraph(
  graph: SemanticGraph,
  selected: ReadonlyMap<string, PackageExportInfo>,
  inference?: GraphInferenceResult | null,
  bindings?: CompiledGraphBindings,
): PackageBundleGraph {
  const definitions = new Map<string, ReadonlyMap<string, WheelAdapterValueDefinition>>()
  for (const [key, packageInfo] of selected) {
    const definition = parseDefinition(typeof packageInfo.definition === "string" ? JSON.parse(packageInfo.definition) : packageInfo.definition)
    definitions.set(key.slice(0, key.lastIndexOf("@")), new Map((definition.wheelAdapters ?? []).map((adapter) => [adapter.name, adapter])))
  }
  const nodes = graph.nodes.map((node) => ({
    ...node,
    ...(bindings?.inputBindings.find((binding) => binding.nodeId === node.id) === undefined
      ? {}
      : { inputBinding: bindings.inputBindings.find((binding) => binding.nodeId === node.id)!.name }),
    wheelAdapters: node.wheelAdapters.map((name) => {
      if (!name.trim()) throw new Error(`graph node '${node.id}' has an empty wheel adapter binding`)
      const declaration = definitions.get(node.package.id)?.get(name)
      if (!declaration) throw new Error(`graph node '${node.id}' selects undeclared wheel adapter '${name}'`)
      return bindAdapter(node, name, declaration, graph.edges, inference)
    }),
  }))
  return {
    ...graph,
    inputBindings: bindings?.inputBindings ?? [],
    objectiveBindings: bindings?.objectiveBindings ?? [],
    nodes,
  }
}

type WheelAdapterValueDefinition = {
  readonly name: string
  readonly input: WheelAdapterValueSchema
  readonly output: WheelAdapterValueSchema
}

function bindAdapter(
  node: SemanticGraph["nodes"][number],
  name: string,
  declaration: WheelAdapterValueDefinition,
  edges: SemanticGraph["edges"],
  inference?: GraphInferenceResult | null,
): PackageBundleAdapterBinding {
  const input = declaration.input.type === "tensor"
    ? inferredInput(node.id, edges, inference)
    : declaration.input
  const output = declaration.output.type === "tensor"
    ? inferredOutput(node.id, inference)
    : declaration.output
  return {
    name,
    input: compatibleSchema(declaration.input, input, "input", name, node.id),
    output: compatibleSchema(declaration.output, output, "output", name, node.id),
  }
}

function inferredInput(nodeId: string, edges: SemanticGraph["edges"], inference?: GraphInferenceResult | null): WheelAdapterValueSchema {
  if (!inference) throw new Error(`graph node '${nodeId}' wheel adapter input cannot be inferred`)
  const incoming = edges.filter((edge) => edge.target === nodeId)
  if (incoming.length !== 1) throw new Error(`graph node '${nodeId}' wheel adapter input requires exactly one inferred source`)
  const result = inference.nodes.get(incoming[0]!.source)
  if (!result || result.status !== "success") throw new Error(`graph node '${nodeId}' wheel adapter input inference is unavailable`)
  return { type: "tensor", shape: result.output.shape, dtype: result.output.dtype }
}

function inferredOutput(nodeId: string, inference?: GraphInferenceResult | null): WheelAdapterValueSchema {
  const result = inference?.nodes.get(nodeId)
  if (!result || result.status !== "success") throw new Error(`graph node '${nodeId}' wheel adapter output inference is unavailable`)
  return { type: "tensor", shape: result.output.shape, dtype: result.output.dtype }
}

function compatibleSchema(
  declaration: WheelAdapterValueSchema,
  actual: WheelAdapterValueSchema,
  role: "input" | "output",
  adapter: string,
  nodeId: string,
): WheelAdapterValueSchema {
  if (declaration.type !== actual.type) throw new Error(`graph node '${nodeId}' wheel adapter '${adapter}' ${role} type is incompatible`)
  if (declaration.type !== "tensor" || actual.type !== "tensor") return declaration
  if (declaration.dtype !== actual.dtype || declaration.shape.length !== actual.shape.length || declaration.shape.some((dimension, index) => typeof dimension === "number" && dimension !== actual.shape[index])) {
    throw new Error(`graph node '${nodeId}' wheel adapter '${adapter}' ${role} schema is incompatible`)
  }
  return actual
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function semanticGraph(nodes: readonly Node[], edges: readonly Edge[]): SemanticGraph {
  const seen = new Set<string>()
  const graphNodes = nodes.map((candidate) => {
    const node = candidate as PackageNode
    if (seen.has(node.id)) throw new Error(`duplicate graph node '${node.id}'`)
    seen.add(node.id)
    const identity = node.data?.package
    if (!identity || !identity.id || !identity.version || !identity.name) {
      throw new Error(`graph node '${node.id}' has no complete package identity`)
    }
    if (!node.type) throw new Error(`graph node '${node.id}' has no node type`)
    return {
      id: node.id,
      type: node.type,
      package: { id: identity.id, version: identity.version, name: identity.name },
      params: (node.data?.params ?? {}) as Readonly<Record<string, unknown>>,
      wheelAdapters: [...(node.data?.wheelAdapters ?? [])].sort(),
      parentId: node.parentId ?? null,
      ...(typeof node.data?.inputBinding === "string" ? { inputBinding: node.data.inputBinding } : {}),
    }
  }).sort((left, right) => left.id.localeCompare(right.id))

  const graphEdges = edges.map((edge) => {
    if (!seen.has(edge.source) || !seen.has(edge.target)) throw new Error(`edge '${edge.id}' references an unknown node`)
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    }
  }).sort((left, right) => [left.target, left.targetHandle ?? "", left.source, left.id]
    .join("\u0000").localeCompare([right.target, right.targetHandle ?? "", right.source, right.id].join("\u0000")))
  return { nodes: graphNodes, edges: graphEdges }
}

async function file(path: string, content: string | Uint8Array): Promise<PackageBundleFile> {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content)
  return { path, content: toBase64(bytes), size: bytes.byteLength, sha256: await sha256Bytes(bytes) }
}

/** Select one exact installed export; a bare ID can never satisfy this lookup. */
function exactExport(exports: ReadonlyMap<string, PackageExportInfo>, identity: PersistedPackageIdentity): PackageExportInfo {
  const matches = [...exports.values()].filter((candidate) => (
    candidate.manifest.id === identity.id && candidate.manifest.version === identity.version
  ))
  if (matches.length === 0) throw new Error(`package '${identity.id}@${identity.version}' is not active`)
  if (matches.length > 1) throw new Error(`package '${identity.id}@${identity.version}' is ambiguous`)
  return matches[0]!
}

function assertUsable(packageInfo: PackageExportInfo, key: string): void {
  if ((packageInfo.state !== undefined && packageInfo.state !== "active") || packageInfo.active === false) throw new Error(`package '${key}' is not active`)
  // Contract v1 treats Input as the graph boundary; it has no executable
  // factory in the current catalog, while every executable package must.
  const pytorch = packageInfo.manifest.entrypoints.pytorch?.file
  const hasPytorch = packageInfo.resources
    ? pytorch !== undefined && packageInfo.resources[pytorch] !== undefined
    : packageInfo.pytorch !== undefined
  if (packageInfo.manifest.id !== "core.input" && !hasPytorch) {
    throw new Error(`package '${key}' has no PyTorch entrypoint`)
  }
}

function resolveDependency(
  exports: ReadonlyMap<string, PackageExportInfo>,
  packageInfo: PackageExportInfo,
  packageKeyValue: string,
  dependency: string,
): string {
  const resolved = packageInfo.resolvedDependencies?.[dependency]
  if (resolved !== undefined) {
    const separator = resolved.lastIndexOf("@")
    if (separator <= 0) throw new Error(`package '${packageKeyValue}' has invalid resolved dependency '${resolved}'`)
    const id = resolved.slice(0, separator)
    const version = resolved.slice(separator + 1)
    if (id !== dependency || !satisfies(version, packageInfo.manifest.dependencies[dependency]!)) {
      throw new Error(`package '${packageKeyValue}' dependency '${dependency}' resolves to wrong version '${resolved}'`)
    }
    exactExport(exports, { id, version })
    return resolved
  }
  const candidates = [...exports.values()].filter((candidate) => (
    candidate.manifest.id === dependency && satisfies(candidate.manifest.version, packageInfo.manifest.dependencies[dependency]!)
  ))
  if (candidates.length === 0) throw new Error(`package '${packageKeyValue}' dependency '${dependency}' is not active`)
  if (candidates.length > 1) throw new Error(`package '${packageKeyValue}' dependency '${dependency}' is ambiguous`)
  const candidate = candidates[0]!
  const key = packageKey(candidate.manifest.id, candidate.manifest.version)
  assertUsable(candidate, key)
  return key
}

function resolveDependencyMap(exports: ReadonlyMap<string, PackageExportInfo>, packageInfo: PackageExportInfo, key: string): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.keys(packageInfo.manifest.dependencies).sort().map((dependency) => [
    dependency,
    resolveDependency(exports, packageInfo, key, dependency),
  ]))
}

function packageDiagnosticIdentity(key: string): PersistedPackageIdentity {
  const separator = key.lastIndexOf("@")
  return { id: key.slice(0, separator), version: key.slice(separator + 1) }
}

async function packageFiles(packageInfo: PackageExportInfo): Promise<PackageBundleFile[]> {
  const resources = packageInfo.resources
  const entries: Array<[string, string | Uint8Array]> = resources
    ? Object.entries(resources)
    : [
        ["manifest.json", JSON.stringify(packageInfo.manifest)],
        [packageInfo.manifest.entrypoints.definition, typeof packageInfo.definition === "string" ? packageInfo.definition : JSON.stringify(packageInfo.definition)],
        ...(packageInfo.manifest.entrypoints.inference ? [] : []),
        ...(packageInfo.pytorch === undefined ? [] : [[packageInfo.manifest.entrypoints.pytorch?.file ?? "pytorch.py", packageInfo.pytorch] as [string, string]]),
      ]
  if (resources) {
    for (const path of ["manifest.json", packageInfo.manifest.entrypoints.definition, packageInfo.manifest.entrypoints.inference?.file, packageInfo.manifest.entrypoints.pytorch?.file]) {
      if (path !== undefined && !entries.some(([candidate]) => candidate === path)) throw new Error(`package '${packageInfo.manifest.id}@${packageInfo.manifest.version}' resource '${path}' is missing`)
    }
  }
  return Promise.all(entries.sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => file(path, content)))
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("bundle cannot contain non-finite numbers")
    return value
  }
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalize(item))
  if (typeof value === "object") {
    const object = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(object[key])]))
  }
  throw new Error("bundle cannot contain unsupported values")
}

async function sha256(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value))
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== "function") throw new Error("Web Crypto is required to build a package bundle")
  const digest = await globalThis.crypto.subtle.digest("SHA-256", value as unknown as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function toBase64(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}
