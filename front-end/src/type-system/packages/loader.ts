import { PackageCatalog } from "./catalog"
import { PackageRegistry } from "./registry"
import { satisfies } from "./semver"
import { resolveParameters } from "./validation"
import type { TensorType } from "../tensor-type"
import type { TypeContext, TypeResult } from "../type-inference"
import type {
  CordisContext,
  InferenceRule,
  InferenceRuntime,
  LoadedInferenceRule,
  Package,
  StereotypeReference,
} from "./types"

export type PackageLease = { readonly id: string; dispose(): Promise<void> }

type Active = {
  readonly packageInfo: Package
  readonly rule: InferenceRule
  readonly fiber: { dispose(): void | Promise<void> }
  leases: number
  readonly dependencies: readonly PackageLease[]
}

/**
 * Activates package plugins under Cordis and keeps package leases separate from
 * semantic inference. In particular, thrown Lua/runtime faults are not turned
 * into TypeResult errors here.
 */
export class PackageLoader {
  private readonly active = new Map<string, Active>()
  private inferenceDepth = 0
  private readonly maximumInferenceDepth = 32

  constructor(
    private readonly context: CordisContext,
    private readonly catalog: PackageCatalog,
    private readonly registry: PackageRegistry,
    private readonly runtime: InferenceRuntime,
  ) {}

  async load(id: string): Promise<PackageLease> { return this.activate(id, []) }

  infer(id: string, context: TypeContext, parameters: Readonly<Record<string, unknown>>): TypeResult {
    const active = this.active.get(id)
    if (!active) return expected(`package '${id}' is not active`)
    if (this.inferenceDepth >= this.maximumInferenceDepth) return expected(`maximum inference depth of ${this.maximumInferenceDepth} exceeded`)
    if (context.kind !== active.packageInfo.definition.kind) return expected(`package '${id}' requires ${active.packageInfo.definition.kind}`)
    if (!hasRequiredInputs(context.kind, context.inputs)) return expected(`package '${id}' received an invalid input count for ${context.kind}`)

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

  private async activate(id: string, trail: readonly string[]): Promise<PackageLease> {
    const existing = this.active.get(id)
    if (existing) { existing.leases++; return this.lease(existing) }
    if (trail.includes(id)) throw new Error(`package '${id}' dependency activation failed: static dependency cycle: ${[...trail, id].join(" -> ")}`)
    const packageInfo = this.catalog.get(id)
    if (!packageInfo) throw new Error(`package '${id}' selection failed: selected package is missing`)

    const dependencies: PackageLease[] = []
    let loaded: LoadedInferenceRule | undefined
    try {
      for (const [dependency, range] of Object.entries(packageInfo.manifest.dependencies)) {
        const target = this.catalog.get(dependency)
        if (!target || !satisfies(target.manifest.version, range)) throw new Error(`static dependency '${dependency}' is missing or incompatible`)
        dependencies.push(await this.activate(dependency, [...trail, id]))
      }
      const inference = packageInfo.manifest.entrypoints.inference
      if (!inference) throw new Error(`package '${id}' has no inference entrypoint`)
      loaded = await this.runtime.load(packageInfo, inference.file)

      let unregister = () => {}
      const fiber = await this.context.plugin({
        name: id,
        apply: (pluginContext) => {
          pluginContext.effect(() => {
            unregister = this.registry.register({ packageInfo, rule: loaded!.infer })
            return async () => {
              this.active.delete(id)
              unregister()
              await loaded?.dispose()
            }
          })
        },
      })
      const active: Active = { packageInfo, rule: loaded.infer, fiber, leases: 1, dependencies }
      this.active.set(id, active)
      return this.lease(active)
    } catch (cause) {
      await loaded?.dispose()
      for (const dependency of dependencies.reverse()) await dependency.dispose()
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`${id}@${packageInfo.manifest.version} activation failed: ${message}`)
    }
  }

  private lease(active: Active): PackageLease {
    let released = false
    return {
      id: active.packageInfo.manifest.id,
      dispose: async () => {
        if (released) return
        released = true
        if (--active.leases !== 0) return
        this.active.delete(active.packageInfo.manifest.id)
        await active.fiber.dispose()
        for (const dependency of [...active.dependencies].reverse()) await dependency.dispose()
      },
    }
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
        return this.infer(reference.id, { kind, inputs: [] }, reference.parameters)
      }
      if (kind === "layer" || kind === "loss" || kind === "subflow") {
        if (inputs.length !== 1) return expected(`package '${reference.id}' requires one input`)
        const input = inputs[0]!
        return this.infer(reference.id, kind === "subflow" ? { kind, inputs: [input], inferSubflow: () => expected("subflow unavailable") } : { kind, inputs: [input] }, reference.parameters)
      }
      if (inputs.length < 2) return expected(`package '${reference.id}' requires two inputs`)
      return this.infer(reference.id, { kind, inputs: [inputs[0]!, inputs[1]!, ...inputs.slice(2)] }, reference.parameters)
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
