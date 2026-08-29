import { readJson } from "./path"
import { parseDefinition, parseManifest } from "./validation"
import { satisfies } from "./semver"
import { createInstalledPackageRecord } from "./installed/records"
import type {
  InstalledPackageRecord,
  Package,
  PackageBundle,
  PackageKey,
  PackageResourceMap,
  PackageResourceProvider,
} from "./types"

export class PackageConflictError extends Error {
  readonly code = "package-conflict" as const
  constructor(key: PackageKey) { super(`package '${key}' is already installed with different bytes`); this.name = "PackageConflictError" }
}

export class BundledPackageCollisionError extends Error {
  readonly code = "bundled-package-collision" as const
  constructor(id: string) { super(`external package '${id}' collides with a bundled package`); this.name = "BundledPackageCollisionError" }
}

export function packageKey(id: string, version: string): PackageKey { return `${id}@${version}` as PackageKey }
export function packageRecordKey(record: Pick<InstalledPackageRecord, "manifest">): PackageKey { return packageKey(record.manifest.id, record.manifest.version) }

/** Immutable selection of exact package versions. */
export class PackageCatalog {
  private readonly packages = new Map<PackageKey, Package | InstalledPackageRecord>()

  static fromBundles(bundles: readonly PackageBundle[]): PackageCatalog {
    const catalog = new PackageCatalog()
    for (const bundle of bundles) catalog.addLegacy(bundle)
    return catalog
  }

  static fromRecords(records: readonly InstalledPackageRecord[]): PackageCatalog {
    const catalog = new PackageCatalog()
    for (const record of records) catalog.addRecord(record)
    return catalog
  }

  static compose(bundled: readonly InstalledPackageRecord[], external: readonly InstalledPackageRecord[]): PackageCatalog {
    const catalog = PackageCatalog.fromRecords(bundled)
    const bundledIds = new Set(bundled.map((record) => record.manifest.id))
    for (const record of external) {
      if (bundledIds.has(record.manifest.id)) throw new BundledPackageCollisionError(record.manifest.id)
      catalog.addRecord(record)
    }
    return catalog
  }

  static async fromStore(
    bundled: readonly InstalledPackageRecord[],
    store: { readonly list: () => Promise<readonly InstalledPackageRecord[]> },
  ): Promise<PackageCatalog> { return PackageCatalog.compose(bundled, await store.list()) }

  /** Build a catalog from bundled manifest/definition resources. */
  static async fromResources(
    bundles: readonly { readonly resources: PackageResourceProvider | PackageResourceMap; readonly manifest?: string; readonly definition?: string; readonly directory?: string }[],
  ): Promise<PackageCatalog> {
    const parsed: PackageBundle[] = []
    const installed: InstalledPackageRecord[] = []
    for (const bundle of bundles) {
      const manifestPath = bundle.manifest ?? "manifest.json"
      const manifest = parseManifest(await readJson(bundle.resources, manifestPath))
      const definition = parseDefinition(await readJson(bundle.resources, bundle.definition ?? manifest.entrypoints.definition))
      const enumerableResources = !("read" in bundle.resources)
      const resourceMap = enumerableResources ? bundle.resources as PackageResourceMap : undefined
      const complete = enumerableResources && [manifest.entrypoints.definition, manifest.entrypoints.inference?.file, manifest.entrypoints.pytorch?.file]
        .every((path) => path === undefined || resourceMap![path] !== undefined)
      if (complete) {
        installed.push(await createInstalledPackageRecord({ source: "bundled", manifest, definition, resources: resourceMap! }))
      } else {
        parsed.push({ manifest, definition, resources: bundle.resources, ...(bundle.directory ? { directory: bundle.directory } : {}) })
      }
    }
    const catalog = PackageCatalog.fromRecords(installed)
    for (const bundle of parsed) catalog.addLegacy(bundle)
    return catalog
  }

  /** Exact lookup by `id@version`. A bare ID remains a transition helper only. */
  get(key: PackageKey | string): Package | InstalledPackageRecord | undefined {
    if (key.includes("@")) return cloneCatalogValue(this.packages.get(key as PackageKey))
    const matches = [...this.packages.entries()].filter(([candidate]) => candidate.startsWith(`${key}@`))
    return matches.length === 1 ? cloneCatalogValue(matches[0]![1]) : undefined
  }

  getExact(key: PackageKey): Package | InstalledPackageRecord | undefined { return cloneCatalogValue(this.packages.get(key)) }
  getById(id: string): readonly (Package | InstalledPackageRecord)[] {
    return [...this.packages.entries()].filter(([key]) => key.startsWith(`${id}@`)).sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => cloneCatalogValue(value)!)
  }
  query(id: string, range?: string): readonly (Package | InstalledPackageRecord)[] {
    return this.getById(id).filter((candidate) => range === undefined || satisfies(candidate.manifest.version, range))
  }
  find(id: string, range: string): Package | InstalledPackageRecord | undefined {
    const candidates = this.query(id, range)
    return candidates.length === 1 ? candidates[0] : undefined
  }
  resolveDependencies(key: PackageKey): Readonly<Record<string, PackageKey>> {
    const packageInfo = this.getExact(key)
    if (!packageInfo) throw new Error(`package '${key}' is not installed`)
    const resolved: Record<string, PackageKey> = {}
    for (const [id, range] of Object.entries(packageInfo.manifest.dependencies)) {
      const candidates = this.query(id, range)
      if (candidates.length !== 1) throw new Error(`dependency '${id}' for '${key}' is missing or ambiguous`)
      resolved[id] = packageRecordKey(candidates[0] as InstalledPackageRecord)
    }
    return Object.freeze(resolved)
  }
  keys(): readonly PackageKey[] { return [...this.packages.keys()].sort() }
  values(): IterableIterator<Package | InstalledPackageRecord> { return this.keys().map((key) => cloneCatalogValue(this.packages.get(key))!).values() }
  records(): readonly (Package | InstalledPackageRecord)[] { return this.keys().map((key) => cloneCatalogValue(this.packages.get(key))!) }

  private addRecord(record: InstalledPackageRecord): void {
    if (record.key !== packageRecordKey(record)) throw new Error(`package record key '${record.key}' does not match its manifest`)
    if ([...this.packages.values()].some((candidate) => candidate.manifest.id === record.manifest.id && isBundled(candidate) !== isBundled(record))) throw new BundledPackageCollisionError(record.manifest.id)
    if (this.packages.has(record.key)) throw new Error(`selected package '${record.key}' appears more than once`)
    this.packages.set(record.key, immutableRecord(record))
  }

  private addLegacy(bundle: PackageBundle): void {
    const { manifest, definition } = bundle
    if (definition.kind === "input" && manifest.entrypoints.pytorch) throw new Error("input packages must not define a PyTorch entrypoint")
    const key = packageRecordKey({ manifest })
    if (this.packages.has(key)) throw new Error(`selected package '${key}' appears more than once`)
    this.packages.set(key, bundle)
  }
}

export const InstalledPackageCatalog = PackageCatalog

export async function composeInstalledPackageCatalog(
  bundled: readonly InstalledPackageRecord[],
  store: { readonly list: () => Promise<readonly InstalledPackageRecord[]> },
): Promise<PackageCatalog> { return PackageCatalog.fromStore(bundled, store) }

function isBundled(packageInfo: Package | InstalledPackageRecord): boolean { return "source" in packageInfo && packageInfo.source === "bundled" }

function cloneCatalogValue(value: Package | InstalledPackageRecord | undefined): Package | InstalledPackageRecord | undefined {
  return value === undefined ? undefined : ("source" in value ? immutableRecord(value) : value)
}

/** Clone and freeze catalog-owned metadata; callers never receive input objects. */
export function immutableRecord(record: InstalledPackageRecord): InstalledPackageRecord {
  const resources: Record<string, Uint8Array> = {}
  for (const path of Object.keys(record.resources).sort()) {
    const bytes = record.resources[path]
    if (bytes === undefined) throw new Error(`package resource '${path}' is undefined`)
    const immutableBytes = new Uint8Array(bytes)
    Object.defineProperty(resources, path, {
      configurable: false,
      enumerable: true,
      get: () => new Uint8Array(immutableBytes),
    })
  }
  const result: InstalledPackageRecord = {
    key: record.key,
    source: record.source,
    manifest: structuredClone(record.manifest),
    definition: structuredClone(record.definition),
    resources,
    digest: record.digest,
    resolvedDependencies: structuredClone(record.resolvedDependencies),
  }
  Object.freeze(result.manifest); Object.freeze(result.definition); Object.freeze(result.resources); Object.freeze(result.resolvedDependencies)
  return Object.freeze(result)
}
