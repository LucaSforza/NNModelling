import { Service, type Context } from "cordis"

import { LuaPackageInferenceRuntime } from "./lua-runtime"
import { PackageRegistry, type ActivePackage } from "./registry"
import type { InferenceRuntime, LoadedInferenceRule, Package } from "./types"

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
  }
}
