import { readJson } from "./path"
import { parseDefinition, parseManifest } from "./validation"
import type { Package, PackageBundle, PackageResourceMap, PackageResourceProvider } from "./types"

/** Immutable selection of the exact package versions supplied by the browser. */
export class PackageCatalog {
  private readonly packages = new Map<string, Package>()

  static fromBundles(bundles: readonly PackageBundle[]): PackageCatalog {
    const catalog = new PackageCatalog()
    for (const bundle of bundles) catalog.add(bundle)
    return catalog
  }

  /** Build a catalog from bundled manifest/definition resources. */
  static async fromResources(
    bundles: readonly { readonly resources: PackageResourceProvider | PackageResourceMap; readonly manifest?: string; readonly definition?: string; readonly directory?: string }[],
  ): Promise<PackageCatalog> {
    const parsed: PackageBundle[] = []
    for (const bundle of bundles) {
      const manifestPath = bundle.manifest ?? "manifest.json"
      const manifest = parseManifest(await readJson(bundle.resources, manifestPath))
      const definition = parseDefinition(await readJson(bundle.resources, bundle.definition ?? manifest.entrypoints.definition))
      parsed.push({ manifest, definition, resources: bundle.resources, ...(bundle.directory ? { directory: bundle.directory } : {}) })
    }
    return PackageCatalog.fromBundles(parsed)
  }

  get(id: string): Package | undefined { return this.packages.get(id) }
  values(): IterableIterator<Package> { return this.packages.values() }

  private add(bundle: PackageBundle): void {
    const { manifest, definition } = bundle
    if (definition.kind === "input" && manifest.entrypoints.pytorch) throw new Error("input packages must not define a PyTorch entrypoint")
    if (this.packages.has(manifest.id)) throw new Error(`selected package '${manifest.id}' appears more than once`)
    this.packages.set(manifest.id, bundle)
  }
}
