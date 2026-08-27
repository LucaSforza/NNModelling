import type { Edge, Node } from "@xyflow/svelte"
import type { PackageExportInfo } from "../type-system/packages/types"
import type { PackageIdentity } from "../core/types"
import { parseDefinition } from "../type-system/packages/validation"

export type PackageBundleGraph = {
  readonly nodes: readonly {
    readonly id: string
    readonly type: string
    readonly package: PackageIdentity
    readonly params: Readonly<Record<string, unknown>>
    readonly wheelAdapters: readonly string[]
    readonly parentId: string | null
  }[]
  readonly edges: readonly {
    readonly id: string
    readonly source: string
    readonly target: string
    readonly sourceHandle: string | null
    readonly targetHandle: string | null
  }[]
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

type PackageNode = Node & { data?: { package?: PackageIdentity; params?: Record<string, unknown>; wheelAdapters?: readonly string[] } }

/** Build the content-addressed, semantic package transport without running Python. */
export async function buildPackageBundle(
  nodes: readonly Node[],
  edges: readonly Edge[],
  exports: ReadonlyMap<string, PackageExportInfo>,
): Promise<PackageBundleV1> {
  const graph = semanticGraph(nodes, edges)
  const selected = new Map<string, PackageExportInfo>()
  const visit = (identity: PackageIdentity): void => {
    const current = selected.get(identity.id)
    if (current) {
      if (current.manifest.version !== identity.version) {
        throw new Error(`package '${identity.id}' has conflicting versions in graph`)
      }
      return
    }
    const packageInfo = exports.get(identity.id)
    if (!packageInfo) throw new Error(`package '${identity.id}' is not active`)
    if (packageInfo.manifest.version !== identity.version) {
      throw new Error(`package '${identity.id}' version '${identity.version}' is not active`)
    }
    // Contract v1 treats Input as the graph boundary; it has no executable
    // factory in the current catalog, while every executable package must.
    if (packageInfo.manifest.id !== "core.input" && !packageInfo.pytorch) {
      throw new Error(`package '${identity.id}' has no PyTorch entrypoint`)
    }
    selected.set(identity.id, packageInfo)
    for (const dependency of Object.keys(packageInfo.manifest.dependencies).sort()) {
      const dependencyInfo = exports.get(dependency)
      if (!dependencyInfo) throw new Error(`package '${identity.id}' dependency '${dependency}' is not active`)
      visit({ id: dependency, version: dependencyInfo.manifest.version, name: dependencyInfo.manifest.id })
    }
  }
  for (const node of graph.nodes) visit(node.package)
  validateWheelAdapterBindings(graph, selected)

  const packages = await Promise.all([...selected.values()]
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
    .map(async (packageInfo) => {
      const files = [
        await file("manifest.json", JSON.stringify(packageInfo.manifest)),
        await file("stereotype.json", packageInfo.definition),
        ...(packageInfo.pytorch === undefined ? [] : [await file("pytorch.py", packageInfo.pytorch)]),
      ]
      return {
        id: packageInfo.manifest.id,
        version: packageInfo.manifest.version,
        dependencies: packageInfo.manifest.dependencies,
        manifest: packageInfo.manifest,
        files: Object.fromEntries(
          files
            .sort((left, right) => left.path.localeCompare(right.path))
            .map((entry) => [entry.path, {
              ...entry,
              content: toBase64(entry.content),
            }]),
        ),
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

function validateWheelAdapterBindings(
  graph: PackageBundleGraph,
  selected: ReadonlyMap<string, PackageExportInfo>,
): void {
  const definitions = new Map<string, ReadonlySet<string>>()
  for (const [id, packageInfo] of selected) {
    const definition = parseDefinition(JSON.parse(packageInfo.definition))
    definitions.set(id, new Set((definition.wheelAdapters ?? []).map((adapter) => adapter.name)))
  }
  for (const node of graph.nodes) {
    const available = definitions.get(node.package.id) ?? new Set<string>()
    for (const adapter of node.wheelAdapters) {
      if (!adapter.trim()) throw new Error(`graph node '${node.id}' has an empty wheel adapter binding`)
      if (!available.has(adapter)) {
        throw new Error(`graph node '${node.id}' selects undeclared wheel adapter '${adapter}'`)
      }
    }
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function semanticGraph(nodes: readonly Node[], edges: readonly Edge[]): PackageBundleGraph {
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

async function file(path: string, content: string): Promise<PackageBundleFile> {
  const normalized = path.endsWith(".py") ? content.replace(/\r\n/g, "\n") : canonicalJson(JSON.parse(content))
  return { path, content: normalized, size: new TextEncoder().encode(normalized).byteLength, sha256: await sha256(normalized) }
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
  if (typeof globalThis.crypto?.subtle?.digest !== "function") throw new Error("Web Crypto is required to build a package bundle")
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}
