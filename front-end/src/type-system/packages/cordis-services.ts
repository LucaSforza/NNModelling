import { Service, type Context } from "cordis"

import { LuaPackageInferenceRuntime } from "./lua-runtime"
import { PackageRegistry, type ActivePackage } from "./registry"
import type { InferenceRuntime, LoadedInferenceRule, Package } from "./types"
import {
  resolveDatasetContract,
  type DatasetDefinition,
  type DatasetParameterValue,
  type ResolvedDatasetContract,
} from "../../project-workspace/dataset-contract"
import type { TensorType } from "../tensor-type"
import type { TypeResult } from "../type-inference"

const SLOT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type DatasetSelection = {
  readonly definition: DatasetDefinition
  readonly parameters: Readonly<Record<string, DatasetParameterValue>>
}

/** Project-scoped dataset definitions. The service itself is stable; entries are dynamic. */
export class DatasetCatalogService extends Service {
  private readonly definitions = new Map<string, DatasetDefinition>()
  private readonly listeners = new Set<() => void>()

  constructor(context: Context) {
    super(context, "datasetCatalog")
  }

  register(definition: DatasetDefinition): () => void {
    const key = `${definition.id}@${definition.version}`
    this.definitions.set(key, definition)
    this.emitChange()
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.definitions.get(key) === definition) {
        this.definitions.delete(key)
        this.emitChange()
      }
    }
  }

  replace(definitions: readonly DatasetDefinition[]): void {
    this.definitions.clear()
    for (const definition of definitions) this.definitions.set(`${definition.id}@${definition.version}`, definition)
    this.emitChange()
  }

  get(id: string, version: string): DatasetDefinition | undefined {
    return this.definitions.get(`${id}@${version}`)
  }

  values(): IterableIterator<DatasetDefinition> { return this.definitions.values() }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener()
  }
}

/** Stable, least-privilege capability consumed by kind=input package Fibers. */
export class DatasetSelectionService extends Service {
  private readonly catalog: DatasetCatalogService
  private selection: DatasetSelection | null = null
  private contract: ResolvedDatasetContract | null = null
  private selectionError: string | null = null

  constructor(context: Context) {
    super(context, "datasetSelection")
    const catalog = context.get("datasetCatalog", true)
    if (!(catalog instanceof DatasetCatalogService)) throw new Error("required Cordis service 'datasetCatalog' is unavailable")
    this.catalog = catalog
    context.fiber.effect(() => catalog.onChange(() => this.refresh()), "dataset selection catalog listener")
  }

  set(selection: DatasetSelection | null): void {
    this.selection = selection
    this.refresh()
  }

  private refresh(): void {
    this.contract = null
    this.selectionError = null
    if (this.selection) {
      const definition = this.catalog.get(this.selection.definition.id, this.selection.definition.version)
      if (!definition) return
      try {
        this.contract = resolveDatasetContract(definition, this.selection.parameters)
      } catch (error) {
        this.selectionError = error instanceof Error ? error.message : String(error)
      }
    }
  }

  current(): DatasetSelection | null { return this.selection }
  resolved(): ResolvedDatasetContract | null { return this.contract }
  error(): string | null { return this.selectionError }

  resolveInput(binding: string, boundary?: TensorType): TypeResult {
    if (boundary) return { status: "success", output: { shape: [...boundary.shape], dtype: boundary.dtype } }
    if (!SLOT_NAME.test(binding)) return { status: "error", message: "input binding must be a valid batch slot name" }
    if (this.selectionError) return { status: "error", message: `dataset selection is invalid: ${this.selectionError}` }
    if (!this.contract) {
      const selected = this.selection
        ? `${this.selection.definition.id}@${this.selection.definition.version}`
        : undefined
      return {
        status: "unresolved",
        reason: selected
          ? `selected dataset '${selected}' is not present in the dataset catalog`
          : `dataset selection is required to resolve Input '${binding}'`,
      }
    }
    const tensor = this.contract.batch.inputs[binding]
    if (!tensor) return { status: "error", message: `Input binding '${binding}' is not declared by dataset` }
    return { status: "success", output: { shape: [...tensor.shape], dtype: tensor.dtype } }
  }
}

/** Cordis service exposing the active package registry to package Fibers. */
export class PackageRegistryService extends Service {
  readonly registry: PackageRegistry

  constructor(context: Context, registry = new PackageRegistry()) {
    super(context, "packageRegistry")
    this.registry = registry
  }

  register(value: ActivePackage): () => void {
    return this.registry.register(value)
  }

  get(id: string): ActivePackage | undefined {
    return this.registry.get(id)
  }

  has(id: string): boolean {
    return this.registry.has(id)
  }

  values(): IterableIterator<ActivePackage> {
    return this.registry.values()
  }
}

/** Cordis service owning the package Lua runtime adapter. */
export class LuaInferenceService extends Service {
  readonly runtime: InferenceRuntime

  constructor(context: Context, runtime: InferenceRuntime = new LuaPackageInferenceRuntime()) {
    super(context, "luaInference")
    this.runtime = runtime
  }

  load(packageInfo: Package, inferenceFile: string): Promise<LoadedInferenceRule> {
    return this.runtime.load(packageInfo, inferenceFile)
  }
}

declare module "cordis" {
  interface Context {
    readonly packageRegistry: PackageRegistryService
    readonly luaInference: LuaInferenceService
    readonly datasetCatalog: DatasetCatalogService
    readonly datasetSelection: DatasetSelectionService
  }
}
