import { Context } from "cordis"

import type { TensorType } from "./tensor-type"
import type { TypeContext } from "./type-inference"
import { PackageCatalog } from "./packages/catalog"
import { PackageLoader } from "./packages/loader"
import { DatasetCatalogService, DatasetSelectionService, LuaInferenceService, PackageRegistryService, type DatasetSelection } from "./packages/cordis-services"
import type { DatasetDefinition, ResolvedDatasetContract } from "../project-workspace/dataset-contract"
import type { PackageResourceMap, PackageResourceProvider } from "./packages/types"
import type { Definition } from "./packages/types"
import type { PackageIdentity } from "../core/types"
import {
  PackageRuntimeDiagnosticCollection,
  type PackageRuntimeDiagnostic,
} from "./diagnostics"

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
  | { readonly status: "unresolved"; readonly reason: string }
  | { readonly status: "success"; readonly output: TensorType }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "fault"
      readonly fault: {
        readonly packageId: string
        readonly phase: "activation" | "inference"
        readonly message: string
      }
    }

/** Frontend owner of Cordis, package leases, and Lua inference capability. */
export class TypeSystemHost {
  private readonly context = new Context()
  private readonly registry: PackageRegistryService
  private readonly loader: PackageLoader
  private readonly diagnosticCollection = new PackageRuntimeDiagnosticCollection()
  private readonly activationAttempts = new Map<string, number>()
  private disposed = false

  private constructor(catalog: PackageCatalog) {
    new PackageRegistryService(this.context)
    new LuaInferenceService(this.context)
    new DatasetCatalogService(this.context)
    new DatasetSelectionService(this.context)
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

  async activate(identity: PackageIdentity): Promise<void> {
    this.assertActive()
    const key = `${identity.id}@${identity.version}`
    const activationAttempt = (this.activationAttempts.get(key) ?? 0) + 1
    this.activationAttempts.set(key, activationAttempt)
    try {
      await this.loader.load(identity)
    } catch (cause) {
      this.recordDiagnostic({
        phase: "activation",
        packageId: identity.id,
        packageVersion: identity.version,
        message: cause instanceof Error ? cause.message : String(cause),
        activationAttempt,
      })
      throw cause
    }
  }

  isActive(identity: PackageIdentity): boolean {
    return this.registry.get(identity.id)?.packageInfo.manifest.version === identity.version
  }

  /** Read-only metadata used by the graph adapter; inference remains package-owned. */
  packageDefinition(identity: PackageIdentity): Definition | undefined {
    const active = this.registry.get(identity.id)
    return active?.packageInfo.manifest.version === identity.version ? active.packageInfo.definition : undefined
  }

  packageVersion(identity: PackageIdentity): string | undefined {
    const active = this.registry.get(identity.id)
    return active?.packageInfo.manifest.version === identity.version ? active.packageInfo.manifest.version : undefined
  }

  activePackages(): ActivePackageMetadata[] {
    return [...this.registry.values()].map(({ packageInfo }) => ({
      id: packageInfo.manifest.id,
      version: packageInfo.manifest.version,
      definition: packageInfo.definition,
    }))
  }

  /** Snapshot of browser-owned fatal package/runtime failures. */
  runtimeDiagnostics(): readonly PackageRuntimeDiagnostic[] {
    return this.diagnosticCollection.snapshot()
  }

  /** Record an adapter-owned failure while retaining the original cause text. */
  recordDiagnostic(input: Parameters<PackageRuntimeDiagnosticCollection["record"]>[0]): PackageRuntimeDiagnostic {
    return this.diagnosticCollection.record(input)
  }

  /** Failure for the exact package reference, used by the graph scheduler. */
  packageRuntimeFailure(identity: PackageIdentity): PackageRuntimeDiagnostic | undefined {
    const key = `${identity.id}@${identity.version}`
    return this.diagnosticCollection.snapshot().find((diagnostic) => (
      diagnostic.packageId && diagnostic.packageVersion &&
      `${diagnostic.packageId}@${diagnostic.packageVersion}` === key &&
      diagnostic.phase !== "inference" && diagnostic.phase !== "disposal"
    ))
  }

  /** Update the stable Cordis dataset capability consumed by kind=input packages. */
  setDatasetSelection(selection: DatasetSelection | null): void {
    this.assertActive()
    const service = this.context.get("datasetSelection", true)
    if (!(service instanceof DatasetSelectionService)) throw new Error("dataset selection service is unavailable")
    service.set(selection)
  }

  /** Replace the current project-scoped catalog without replacing Cordis services. */
  setDatasetCatalog(definitions: readonly DatasetDefinition[]): void {
    this.assertActive()
    const catalog = this.context.get("datasetCatalog", true)
    if (!(catalog instanceof DatasetCatalogService)) throw new Error("dataset catalog service is unavailable")
    catalog.replace(definitions)
  }

  datasetContract(): ResolvedDatasetContract | undefined {
    const service = this.context.get("datasetSelection", true)
    return service instanceof DatasetSelectionService ? service.resolved() ?? undefined : undefined
  }

  /**
   * Adapt semantic inference to editor state without manufacturing an unknown
   * tensor. Required-but-missing parameters stop before Lua invocation.
   */
  inferForEditor(
    identity: PackageIdentity,
    context: TypeContext,
    parameters: Readonly<Record<string, unknown>>,
    nodeId?: string,
  ): EditorInferenceState {
    this.assertActive()
    const active = this.registry.get(identity.id)
    if (active) {
      const missingParameters = Object.entries(active.packageInfo.definition.parameters)
        .filter(([name, definition]) => parameters[name] === undefined && definition.default === undefined)
        .map(([name]) => name)
      if (missingParameters.length > 0) return { status: "unresolved", missingParameters }
    }

    try {
      const result = this.loader.infer(identity, context, parameters)
      return result.status === "unresolved"
        ? { status: "unresolved", reason: result.reason }
        : result
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.recordDiagnostic({
        occurrenceId: `inference:${identity.id}@${identity.version}:${nodeId ?? "global"}`,
        phase: "inference",
        packageId: identity.id,
        packageVersion: identity.version,
        nodeId,
        message,
      })
      return {
        status: "fault",
        fault: {
          packageId: identity.id,
          phase: "inference",
          message,
        },
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      await this.loader.dispose()
    } catch (cause) {
      this.recordDiagnostic({ phase: "disposal", message: cause instanceof Error ? cause.message : String(cause) })
    }
    try {
      await this.context.fiber.dispose()
    } catch (cause) {
      this.recordDiagnostic({ phase: "disposal", message: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("type-system host has been disposed")
  }
}
