import type { Context, Fiber } from "cordis"

import { PackageCatalog, packageKey } from "./catalog"
import { LuaInferenceService, PackageRegistryService } from "./cordis-services"
import { satisfies } from "./semver"
import { resolveParameters } from "./validation"
import type { TensorType } from "../tensor-type"
import type { TypeContext, TypeResult } from "../type-inference"
import type { InferenceRule, Package, StereotypeReference } from "./types"
import type { PackageIdentity } from "../../core/types"

export type PackageLease = { readonly id: string; dispose(): Promise<void> }

type Active = {
  readonly packageInfo: Package
  readonly rule: InferenceRule
  readonly fiber: Fiber
  leases: number
}

/**
 * Activates package plugins under Cordis and keeps package leases separate from
 * semantic inference. In particular, thrown Lua/runtime faults are not turned
 * into TypeResult errors here.
 */
export class PackageLoader {
  private readonly active = new Map<string, Active>()
  private readonly activating = new Map<string, Promise<Active>>()
  private inferenceDepth = 0
  private readonly maximumInferenceDepth = 32

  constructor(
    private readonly context: Context,
    private readonly catalog: PackageCatalog,
  ) {}

  async load(identity: PackageIdentity): Promise<PackageLease> {
    this.services()
    return this.activate(identity, [])
  }

  /** Dispose package Fibers before the host disposes the service/root context. */
  async dispose(): Promise<void> {
    for (const active of [...this.active.values()].reverse()) await active.fiber.dispose()
  }

  infer(identity: PackageIdentity, context: TypeContext, parameters: Readonly<Record<string, unknown>>): TypeResult {
    this.services()
    const active = this.active.get(identity.id)
    if (!active || active.packageInfo.manifest.version !== identity.version) return expected(`package '${identity.id}@${identity.version}' is not active`)
    if (this.inferenceDepth >= this.maximumInferenceDepth) return expected(`maximum inference depth of ${this.maximumInferenceDepth} exceeded`)
    if (context.kind !== active.packageInfo.definition.kind) return expected(`package '${identity.id}' requires ${active.packageInfo.definition.kind}`)
    if (!hasRequiredInputs(context.kind, context.inputs)) return expected(`package '${identity.id}' received an invalid input count for ${context.kind}`)

    let resolved: Readonly<Record<string, unknown>>
    try {
      resolved = resolveParameters(active.packageInfo.definition.parameters, parameters)
    } catch (cause) {
      return expected(cause)
    }

    this.inferenceDepth++
    try {
      const referenceKinds = new Map<string, string>()
      const referenceRanges = new Map<string, string[]>()
      for (const [name, value] of Object.entries(resolved)) {
        const definition = active.packageInfo.definition.parameters[name]
        if (isReference(value) && definition?.type === "stereotype") {
          referenceKinds.set(value.id, definition.kind)
          referenceRanges.set(value.id, [...(referenceRanges.get(value.id) ?? []), value.version])
        }
      }
      const allowed = new Set([...Object.keys(active.packageInfo.manifest.dependencies), ...referenceKinds.keys()])
      const services = {
        inferSubflow: context.kind === "subflow" ? context.inferSubflow : undefined,
        ...(allowed.size > 0 ? {
          inferStereotype: (reference: StereotypeReference, inputs: readonly TensorType[]) => this.inferReference(allowed, referenceKinds, referenceRanges, reference, inputs),
        } : {}),
      }
      // Deliberately no catch around the rule: a runtime/Lua fault is a host
      // failure and must stay distinguishable from an expected TypeResult.
      return active.rule(context, resolved, services)
    } finally {
      this.inferenceDepth--
    }
  }

  private async activate(identity: PackageIdentity, trail: readonly string[]): Promise<PackageLease> {
    const id = identity.id
    const key = packageKey(identity.id, identity.version)
    const existing = this.active.get(id)
    if (existing && existing.packageInfo.manifest.version !== identity.version) throw new Error(`package ID '${id}' is already active as '${packageKey(id, existing.packageInfo.manifest.version)}'`)
    if (existing) return this.lease(existing)
    if (trail.includes(key)) throw new Error(`package '${key}' dependency activation failed: static dependency cycle: ${[...trail, key].join(" -> ")}`)
    const packageInfo = this.catalog.getExact(key)
    if (!packageInfo) throw new Error(`package '${key}' selection failed: selected package is missing`)

    const pending = this.activating.get(key)
    if (pending) return this.lease(await pending)

    const activation = this.createActive(id, packageInfo, trail)
    this.activating.set(key, activation)
    try {
      return this.lease(await activation)
    } finally {
      this.activating.delete(key)
    }
  }

  private async createActive(id: string, packageInfo: Package, trail: readonly string[]): Promise<Active> {
    const services = this.services()
    let fiber: Fiber
    try {
      fiber = this.context.plugin({
        name: id,
        apply: async (pluginContext) => {
          for (const [dependency, range] of Object.entries(packageInfo.manifest.dependencies)) {
            const resolvedKey = "resolvedDependencies" in packageInfo ? packageInfo.resolvedDependencies[dependency] : undefined
            const candidates = resolvedKey
              ? [this.catalog.getExact(resolvedKey)].filter((candidate): candidate is Package => candidate !== undefined)
              : this.catalog.query(dependency, range)
            if (candidates.length !== 1 || candidates[0]!.manifest.id !== dependency || !satisfies(candidates[0]!.manifest.version, range)) {
              throw new Error(`static dependency '${dependency}' is missing or incompatible`)
            }
            const target = candidates[0]!
            const lease = await this.activate({ id: target.manifest.id, version: target.manifest.version, name: target.definition.name }, [...trail, packageKey(id, packageInfo.manifest.version)])
            pluginContext.effect(() => () => lease.dispose(), `package '${id}' dependency '${dependency}'`)
          }

          const inference = packageInfo.manifest.entrypoints.inference
          if (!inference) throw new Error(`package '${id}' has no inference entrypoint`)
          const loaded = await services.luaInference.load(packageInfo, inference.file)
          pluginContext.effect(() => () => loaded.dispose(), `package '${id}' Lua inference`)

          const unregister = services.packageRegistry.register({ packageInfo, rule: loaded.infer })
          const active: Active = { packageInfo, rule: loaded.infer, fiber, leases: 0 }
          this.active.set(id, active)
          pluginContext.effect(() => () => {
            this.active.delete(id)
            unregister()
          }, `package '${id}' registry`)
        },
      })
      await fiber
      const active = this.active.get(id)
      if (!active) throw new Error("package Fiber completed without an active registration")
      return active
    } catch (cause) {
      if (fiber!) await fiber.dispose()
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`${id}@${packageInfo.manifest.version} activation failed: ${message}`, { cause })
    }
  }

  private lease(active: Active): PackageLease {
    active.leases++
    let released = false
    return {
      id: active.packageInfo.manifest.id,
      dispose: async () => {
        if (released) return
        released = true
        if (--active.leases !== 0) return
        await active.fiber.dispose()
      },
    }
  }

  private services(): { readonly packageRegistry: PackageRegistryService; readonly luaInference: LuaInferenceService } {
    const packageRegistry = this.context.get("packageRegistry", true)
    const luaInference = this.context.get("luaInference", true)
    if (!(packageRegistry instanceof PackageRegistryService)) {
      throw new Error("required Cordis service 'packageRegistry' is unavailable")
    }
    if (!(luaInference instanceof LuaInferenceService)) {
      throw new Error("required Cordis service 'luaInference' is unavailable")
    }
    return { packageRegistry, luaInference }
  }

  private inferReference(
    allowed: Set<string>,
    referenceKinds: ReadonlyMap<string, string>,
    referenceRanges: ReadonlyMap<string, readonly string[]>,
    reference: StereotypeReference,
    inputs: readonly TensorType[],
  ): TypeResult {
    if (!allowed.has(reference.id)) return expected(`package '${reference.id}' is not authorized`)
    const target = this.active.get(reference.id)
    if (!target) return expected(`package '${reference.id}' is not active`)
    if (!satisfies(target.packageInfo.manifest.version, reference.version)) return expected(`package '${reference.id}' version is incompatible`)
    const authorizedRanges = referenceRanges.get(reference.id)
    if (authorizedRanges && !authorizedRanges.some(range => satisfies(target.packageInfo.manifest.version, range))) return expected(`package '${reference.id}' version is incompatible`)
    const expectedKind = referenceKinds.get(reference.id)
    if (expectedKind && expectedKind !== target.packageInfo.definition.kind) return expected(`package '${reference.id}' kind is incompatible`)
    target.leases++
    try {
      const kind = target.packageInfo.definition.kind
      if (kind === "input") {
        if (inputs.length !== 0) return expected(`package '${reference.id}' requires no inputs`)
        return this.infer({ id: reference.id, version: target.packageInfo.manifest.version, name: target.packageInfo.definition.name }, { kind, inputs: [] }, reference.parameters)
      }
      if (kind === "layer" || kind === "loss" || kind === "output" || kind === "subflow") {
        if (inputs.length !== 1) return expected(`package '${reference.id}' requires one input`)
        const input = inputs[0]!
        return this.infer({ id: reference.id, version: target.packageInfo.manifest.version, name: target.packageInfo.definition.name }, kind === "subflow" ? { kind, inputs: [input], inferSubflow: () => expected("subflow unavailable") } : { kind, inputs: [input] }, reference.parameters)
      }
      if (inputs.length < 2) return expected(`package '${reference.id}' requires two inputs`)
      return this.infer({ id: reference.id, version: target.packageInfo.manifest.version, name: target.packageInfo.definition.name }, { kind, inputs: [inputs[0]!, inputs[1]!, ...inputs.slice(2)] }, reference.parameters)
    } finally {
      target.leases--
    }
  }
}

function isReference(value: unknown): value is StereotypeReference {
  return !!value && typeof value === "object" && !Array.isArray(value) && "id" in value && "version" in value && "parameters" in value
}

function hasRequiredInputs(kind: string, inputs: readonly TensorType[]): boolean {
  if (kind === "input") return inputs.length === 0
  return kind === "join" ? inputs.length >= 2 : inputs.length === 1
}

function expected(cause: unknown): TypeResult {
  return { status: "error", message: cause instanceof Error ? cause.message : String(cause) }
}
