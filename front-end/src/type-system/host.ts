import { Context } from "cordis"

import type { TensorType } from "./tensor-type"
import type { TypeContext } from "./type-inference"
import { PackageCatalog } from "./packages/catalog"
import { PackageLoader } from "./packages/loader"
import { LuaInferenceService, PackageRegistryService } from "./packages/cordis-services"
import type { PackageResourceMap, PackageResourceProvider } from "./packages/types"
import type { Definition } from "./packages/types"

export type PackageSelection = {
  readonly resources: PackageResourceProvider | PackageResourceMap
  readonly manifest?: string
  readonly definition?: string
  readonly directory?: string
}

export type ActivePackageMetadata = {
  readonly id: string
  readonly version: string
  readonly definition: Definition
}

export type EditorInferenceState =
  | { readonly status: "unresolved"; readonly missingParameters: readonly string[] }
  | { readonly status: "success"; readonly output: TensorType }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "fault"
      readonly fault: {
        readonly packageId: string
        readonly phase: "inference"
        readonly message: string
      }
    }

/** Frontend owner of Cordis, package leases, and Lua inference capability. */
export class TypeSystemHost {
  private readonly context = new Context()
  private readonly registry: PackageRegistryService
  private readonly loader: PackageLoader
  private disposed = false

  private constructor(catalog: PackageCatalog) {
    new PackageRegistryService(this.context)
    new LuaInferenceService(this.context)
    const registry = this.context.get("packageRegistry", true)
    const luaInference = this.context.get("luaInference", true)
    if (!(registry instanceof PackageRegistryService) || !(luaInference instanceof LuaInferenceService)) {
      throw new Error("type-system host requires its Cordis services")
    }
    this.registry = registry
    this.loader = new PackageLoader(this.context, catalog)
  }

  static async create(packages: readonly PackageSelection[]): Promise<TypeSystemHost> {
    return new TypeSystemHost(await PackageCatalog.fromResources(packages))
  }

  async activate(packageId: string): Promise<void> {
    this.assertActive()
    await this.loader.load(packageId)
  }

  isActive(packageId: string): boolean {
    return this.registry.has(packageId)
  }

  /** Read-only metadata used by the graph adapter; inference remains package-owned. */
  packageDefinition(packageId: string): Definition | undefined {
    return this.registry.get(packageId)?.packageInfo.definition
  }

  packageVersion(packageId: string): string | undefined {
    return this.registry.get(packageId)?.packageInfo.manifest.version
  }

  activePackages(): ActivePackageMetadata[] {
    return [...this.registry.values()].map(({ packageInfo }) => ({
      id: packageInfo.manifest.id,
      version: packageInfo.manifest.version,
      definition: packageInfo.definition,
    }))
  }

  /**
   * Adapt semantic inference to editor state without manufacturing an unknown
   * tensor. Required-but-missing parameters stop before Lua invocation.
   */
  inferForEditor(
    packageId: string,
    context: TypeContext,
    parameters: Readonly<Record<string, unknown>>,
  ): EditorInferenceState {
    this.assertActive()
    const active = this.registry.get(packageId)
    if (active) {
      const missingParameters = Object.entries(active.packageInfo.definition.parameters)
        .filter(([name, definition]) => parameters[name] === undefined && definition.default === undefined)
        .map(([name]) => name)
      if (missingParameters.length > 0) return { status: "unresolved", missingParameters }
    }

    try {
      return this.loader.infer(packageId, context, parameters)
    } catch (cause) {
      return {
        status: "fault",
        fault: {
          packageId,
          phase: "inference",
          message: cause instanceof Error ? cause.message : String(cause),
        },
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.loader.dispose()
    await this.context.fiber.dispose()
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("type-system host has been disposed")
  }
}
