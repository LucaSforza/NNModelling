import { BundledPackageCollisionError, PackageCatalog, PackageConflictError, packageKey, packageRecordKey } from "../catalog"
import { createInstalledPackageRecord } from "../installed/records"
import type { InstalledPackageStore } from "../installed/store"
import { parseDefinition, parseManifest } from "../validation"
import { satisfies } from "../semver"
import type { Definition, InstalledPackageRecord, Manifest, Package, PackageKey } from "../types"

/** The DOM-free input contract for local package installation. */
export type LocalPackageFile = {
  readonly relativePath: string
  readonly bytes: Uint8Array
}

export type PackageIdentity = { readonly id: string; readonly version: string }

export type InstallPhase = "normalize" | "validate" | "dependencies" | "digest" | "persist"

export type InstallDiagnosticCode =
  | "empty-selection"
  | "invalid-relative-path"
  | "duplicate-path"
  | "multiple-package-roots"
  | "missing-root-manifest"
  | "multiple-root-manifests"
  | "malformed-manifest"
  | "malformed-definition"
  | "manifest-identity"
  | "missing-entrypoint"
  | "bundled-id-collision"
  | "dependency-missing"
  | "dependency-ambiguous"
  | "dependency-cycle"
  | "changed-duplicate"
  | "store-error"

export type InstallDiagnostic = {
  readonly code: InstallDiagnosticCode
  readonly phase: InstallPhase
  readonly severity: "error"
  readonly message: string
  readonly package?: PackageIdentity
  readonly dependency?: { readonly id: string; readonly range: string }
  readonly path?: string
}

export type ActivationRequest = PackageIdentity & { readonly key: PackageKey }

export type InstallResult =
  | {
      readonly status: "installed"
      readonly package: PackageIdentity
      readonly key: PackageKey
      readonly record: InstalledPackageRecord
      /** T06 consumes this request; the installer never activates a package. */
      readonly activationRequest: ActivationRequest
    }
  | {
      readonly status: "already-installed"
      readonly package: PackageIdentity
      readonly key: PackageKey
      readonly record: InstalledPackageRecord
      readonly activationRequest: ActivationRequest
    }
  | {
      readonly status: "rejected"
      readonly package?: PackageIdentity
      readonly key?: PackageKey
      readonly diagnostic: InstallDiagnostic
    }

export type PackageInstallerOptions = {
  /** The composed bundled + installed catalog at the start of the operation. */
  readonly catalog?: PackageCatalog
  readonly composedCatalog?: PackageCatalog
  readonly store?: InstalledPackageStore
  readonly packageStore?: InstalledPackageStore
  /** Convenience for callers that have not composed a catalog yet. */
  readonly bundled?: readonly InstalledPackageRecord[]
  readonly external?: readonly InstalledPackageRecord[]
}

/**
 * Validate, resolve, digest, and persist one package directory as one use case.
 * No caller-supplied activation callback is invoked here: persistence is the
 * boundary after which T06 may consume `activationRequest`.
 */
export function installLocalPackage(files: readonly LocalPackageFile[], options: PackageInstallerOptions): Promise<InstallResult>
export function installLocalPackage(files: readonly LocalPackageFile[], catalog: PackageCatalog, store: InstalledPackageStore): Promise<InstallResult>
export async function installLocalPackage(
  files: readonly LocalPackageFile[],
  optionsOrCatalog: PackageInstallerOptions | PackageCatalog,
  positionalStore?: InstalledPackageStore,
): Promise<InstallResult> {
  const options: PackageInstallerOptions = optionsOrCatalog instanceof PackageCatalog
    ? { catalog: optionsOrCatalog, store: positionalStore }
    : optionsOrCatalog
  let identity: PackageIdentity | undefined
  try {
    const normalized = normalizeLocalPackageFiles(files)
    const parsed = parseLocalPackage(normalized)
    identity = { id: parsed.manifest.id, version: parsed.manifest.version }

    const catalog = await resolveCatalog(options)
    const available = await availablePackages(catalog, options.store)
    const key = packageKey(identity.id, identity.version)
    const bundled = available.find((item) => item.manifest.id === identity!.id && isBundled(item))
    if (bundled) throw installFailure("bundled-id-collision", "dependencies", `package ID '${identity.id}' belongs to a bundled package`, identity)

    const existing = available.find((item) => packageRecordKey({ manifest: item.manifest }) === key)
    const resolvedDependencies = resolveDependencies(parsed.manifest, identity, available)
    const candidate = await createInstalledPackageRecord({
      source: "external",
      manifest: parsed.manifest,
      definition: parsed.definition,
      resources: normalizedToResourceMap(normalized),
      resolvedDependencies,
    })

    detectCycles(available, candidate)
    const existingDigest = existing && "digest" in existing ? existing.digest : undefined
    if (existingDigest !== undefined && existingDigest !== candidate.digest) {
      throw installFailure("changed-duplicate", "digest", `package '${key}' is already installed with different bytes`, identity)
    }

    const store = requireStore(options)
    const durableExisting = await store.get(key)
    if (durableExisting && durableExisting.digest !== candidate.digest) {
      throw installFailure("changed-duplicate", "digest", `package '${key}' is already installed with different bytes`, identity)
    }
    const persisted = await store.put(candidate)
    const resultRecord = persisted
    const activationRequest = { id: identity.id, version: identity.version, key }
    if (durableExisting !== undefined) return { status: "already-installed", package: identity, key, record: resultRecord, activationRequest }
    return { status: "installed", package: identity, key, record: resultRecord, activationRequest }
  } catch (cause) {
    const diagnostic = cause instanceof InstallFailure ? cause.diagnostic : diagnosticFor(cause, identity)
    const rejectedIdentity = identity ?? diagnostic.package
    return {
      status: "rejected",
      ...(rejectedIdentity ? { package: rejectedIdentity, key: packageKey(rejectedIdentity.id, rejectedIdentity.version) } : {}),
      diagnostic,
    }
  }
}

/** Normalize package-relative paths and remove one browser directory prefix. */
export function normalizeLocalPackageFiles(files: readonly LocalPackageFile[]): readonly LocalPackageFile[] {
  if (!Array.isArray(files) || files.length === 0) throw installFailure("empty-selection", "normalize", "select a non-empty package directory")
  const paths = files.map((file) => normalizePath(file.relativePath))
  const prefixes = new Set(paths.map((path) => path.split("/")[0]!))
  const hasRootPrefix = !paths.includes("manifest.json") && prefixes.size === 1 && paths.some((path) => path.includes("/"))
  if (!hasRootPrefix && !paths.includes("manifest.json") && prefixes.size > 1) {
    throw installFailure("multiple-package-roots", "normalize", "select exactly one package directory")
  }
  const normalized = files.map((file, index) => {
    const path = hasRootPrefix ? paths[index]!.slice(prefixes.values().next().value!.length + 1) : paths[index]!
    if (!path) throw installFailure("invalid-relative-path", "normalize", "package paths must not be empty")
    return { relativePath: path, bytes: copyBytes(file.bytes, path) }
  })
  const seen = new Set<string>()
  for (const file of normalized) {
    if (seen.has(file.relativePath)) throw installFailure("duplicate-path", "normalize", `package path '${file.relativePath}' occurs more than once`, undefined, file.relativePath)
    seen.add(file.relativePath)
  }
  const rootManifests = normalized.filter((file) => file.relativePath === "manifest.json")
  if (rootManifests.length === 0) throw installFailure("missing-root-manifest", "normalize", "package root must contain manifest.json")
  if (rootManifests.length > 1) throw installFailure("multiple-root-manifests", "normalize", "package root must contain exactly one manifest.json")
  return normalized.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

/** Browser-only adapter. The installer itself never receives DOM File objects. */
export async function readBrowserPackageDirectory(files: FileList | readonly File[]): Promise<readonly LocalPackageFile[]> {
  const selected = Array.from(files)
  if (selected.length === 0) return []
  const paths = selected.map((file) => {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
    return relative || file.name
  })
  const roots = new Set(paths.map((path) => path.split("/")[0]!))
  const prefix = roots.size === 1 && paths.some((path) => path.includes("/")) ? [...roots][0]! : undefined
  return Promise.all(selected.map(async (file, index) => ({
    relativePath: prefix && paths[index]!.startsWith(`${prefix}/`) ? paths[index]!.slice(prefix.length + 1) : paths[index]!,
    bytes: new Uint8Array(await file.arrayBuffer()),
  })))
}

type ParsedPackage = { readonly manifest: Manifest; readonly definition: Definition }

function parseLocalPackage(files: readonly LocalPackageFile[]): ParsedPackage {
  const resources = normalizedToResourceMap(files)
  let manifest: Manifest
  try { manifest = parseManifest(JSON.parse(decode(resources["manifest.json"]!))) }
  catch (cause) { throw installFailure("malformed-manifest", "validate", messageOf(cause, "manifest is invalid"), undefined, "manifest.json") }

  const packageIdentity = { id: manifest.id, version: manifest.version }
  let definition: Definition
  try {
    const definitionBytes = resources[manifest.entrypoints.definition]
    if (definitionBytes === undefined) throw new Error(`entrypoint '${manifest.entrypoints.definition}' is missing`)
    definition = parseDefinition(JSON.parse(decode(definitionBytes)))
  } catch (cause) {
    const text = messageOf(cause, "definition is invalid")
    throw installFailure(text.includes("missing") ? "missing-entrypoint" : "malformed-definition", "validate", text, packageIdentity, manifest.entrypoints.definition)
  }
  if (!manifest.entrypoints.inference) throw installFailure("missing-entrypoint", "validate", "external packages must declare a Lua inference entrypoint", packageIdentity)
  if (!manifest.entrypoints.pytorch) throw installFailure("missing-entrypoint", "validate", "external packages must declare a Python entrypoint", packageIdentity)
  if (resources[manifest.entrypoints.inference.file] === undefined) throw installFailure("missing-entrypoint", "validate", `Lua entrypoint '${manifest.entrypoints.inference.file}' is missing`, packageIdentity, manifest.entrypoints.inference.file)
  if (resources[manifest.entrypoints.pytorch.file] === undefined) throw installFailure("missing-entrypoint", "validate", `Python entrypoint '${manifest.entrypoints.pytorch.file}' is missing`, packageIdentity, manifest.entrypoints.pytorch.file)
  return { manifest, definition }
}

function resolveDependencies(manifest: Manifest, identity: PackageIdentity, available: readonly PackageLike[]): Readonly<Record<string, PackageKey>> {
  const resolved: Record<string, PackageKey> = {}
  for (const [id, range] of Object.entries(manifest.dependencies)) {
    const candidates = available.filter((item) => item.manifest.id === id && satisfies(item.manifest.version, range))
    if (candidates.length === 0) throw installFailure("dependency-missing", "dependencies", `dependency '${id}' (${range}) for '${identity.id}@${identity.version}' is not installed`, identity, undefined, { id, range })
    if (candidates.length > 1) throw installFailure("dependency-ambiguous", "dependencies", `dependency '${id}' (${range}) for '${identity.id}@${identity.version}' matches ${candidates.length} installed versions`, identity, undefined, { id, range })
    resolved[id] = packageRecordKey(candidates[0]!)
  }
  return Object.freeze(resolved)
}

function detectCycles(available: readonly PackageLike[], candidate: InstalledPackageRecord): void {
  const records = new Map<PackageKey, PackageLike | InstalledPackageRecord>()
  for (const item of available) records.set(packageRecordKey({ manifest: item.manifest }), item)
  records.set(candidate.key, candidate)
  const visiting = new Set<PackageKey>()
  const visited = new Set<PackageKey>()
  const visit = (key: PackageKey, trail: readonly PackageKey[]): void => {
    if (visiting.has(key)) {
      const cycle = [...trail.slice(trail.indexOf(key)), key].join(" -> ")
      throw installFailure("dependency-cycle", "dependencies", `static dependency cycle detected: ${cycle}`, identityFromKey(candidate.key))
    }
    if (visited.has(key)) return
    const record = records.get(key)
    if (!record) return
    visiting.add(key)
    const dependencies = "resolvedDependencies" in record && Object.keys(record.resolvedDependencies).length > 0
      ? Object.values(record.resolvedDependencies)
      : []
    for (const dependency of dependencies) visit(dependency, [...trail, key])
    visiting.delete(key)
    visited.add(key)
  }
  for (const key of records.keys()) visit(key, [])
}

type PackageLike = Package & { readonly manifest: Manifest }

async function resolveCatalog(options: PackageInstallerOptions): Promise<PackageCatalog> {
  if (options.catalog) return options.catalog
  if (options.composedCatalog) return options.composedCatalog
  if (options.bundled) return PackageCatalog.compose(options.bundled, options.external ?? [])
  throw new Error("a composed package catalog is required")
}

async function availablePackages(catalog: PackageCatalog, store: InstalledPackageStore | undefined): Promise<readonly PackageLike[]> {
  const values = [...catalog.values()] as PackageLike[]
  if (!store) return values
  const fromStore = await store.list()
  const byKey = new Map(values.map((value) => [packageRecordKey({ manifest: value.manifest }), value]))
  for (const record of fromStore) if (!byKey.has(record.key)) byKey.set(record.key, record)
  return [...byKey.values()]
}

function requireStore(options: PackageInstallerOptions): InstalledPackageStore {
  const store = options.store ?? options.packageStore
  if (!store) throw new Error("an installed package store is required")
  return store
}

function normalizedToResourceMap(files: readonly LocalPackageFile[]): Record<string, Uint8Array> {
  return Object.fromEntries(files.map((file) => [file.relativePath, new Uint8Array(file.bytes)]))
}

function normalizePath(path: unknown): string {
  if (typeof path !== "string" || !path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.endsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw installFailure("invalid-relative-path", "normalize", "package paths must be non-empty relative paths using '/'")
  }
  return path
}

function copyBytes(bytes: unknown, path: string): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw installFailure("invalid-relative-path", "normalize", `bytes for '${path}' must be a Uint8Array`, undefined, path)
  return new Uint8Array(bytes)
}

function decode(bytes: Uint8Array): string { return new TextDecoder().decode(bytes) }

function isBundled(value: PackageLike): boolean { return "source" in value && value.source === "bundled" }

function identityFromKey(key: PackageKey): PackageIdentity {
  const split = key.lastIndexOf("@")
  return { id: key.slice(0, split), version: key.slice(split + 1) }
}

function installFailure(code: InstallDiagnosticCode, phase: InstallPhase, message: string, packageInfo?: PackageIdentity, path?: string, dependency?: { readonly id: string; readonly range: string }): InstallFailure {
  return new InstallFailure({ code, phase, severity: "error", message, ...(packageInfo ? { package: packageInfo } : {}), ...(path ? { path } : {}), ...(dependency ? { dependency } : {}) })
}

function diagnosticFor(cause: unknown, packageInfo?: PackageIdentity): InstallDiagnostic {
  if (cause instanceof BundledPackageCollisionError) return { code: "bundled-id-collision", phase: "dependencies", severity: "error", message: cause.message, ...(packageInfo ? { package: packageInfo } : {}) }
  if (cause instanceof PackageConflictError) return { code: "changed-duplicate", phase: "digest", severity: "error", message: cause.message, ...(packageInfo ? { package: packageInfo } : {}) }
  return { code: "store-error", phase: "persist", severity: "error", message: messageOf(cause, "package installation failed"), ...(packageInfo ? { package: packageInfo } : {}) }
}

function messageOf(cause: unknown, fallback: string): string { return cause instanceof Error ? cause.message : typeof cause === "string" ? cause : fallback }

class InstallFailure extends Error {
  readonly diagnostic: InstallDiagnostic
  constructor(diagnostic: InstallDiagnostic) { super(diagnostic.message); this.name = "InstallFailure"; this.diagnostic = diagnostic }
}
