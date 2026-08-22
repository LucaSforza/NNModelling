import type { TypeGraphSnapshot, GraphInferenceResult } from "./graph/types"
import { PackageGraphScheduler } from "./graph/scheduler"
import { TypeSystemHost, type ActivePackageMetadata } from "./host"
import { bundledCorePackages } from "./bundled/catalog"

/** Frontend lifecycle owner for bundled package inference. */
export class EditorTypeSystemRuntime {
  private constructor(
    private readonly host: TypeSystemHost,
    private readonly scheduler: PackageGraphScheduler,
  ) {}

  static async create(): Promise<EditorTypeSystemRuntime> {
    const packages = bundledCorePackages()
    const host = await TypeSystemHost.create(packages)
    try {
      for (const selection of packages) {
        const manifest = JSON.parse(String((selection.resources as Record<string, string>)["manifest.json"])) as { id: string }
        await host.activate(manifest.id)
      }
      return new EditorTypeSystemRuntime(host, new PackageGraphScheduler(host))
    } catch (cause) {
      await host.dispose()
      throw cause
    }
  }

  infer(snapshot: TypeGraphSnapshot): GraphInferenceResult {
    return this.scheduler.infer(snapshot)
  }

  packages(): ActivePackageMetadata[] {
    return this.host.activePackages()
  }

  dispose(): Promise<void> {
    return this.host.dispose()
  }
}
