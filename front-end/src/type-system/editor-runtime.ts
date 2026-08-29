import type { TypeGraphSnapshot, GraphInferenceResult } from "./graph/types"
import { PackageGraphScheduler } from "./graph/scheduler"
import { TypeSystemHost, type ActivePackageMetadata, type PackageSelection } from "./host"
import { bundledCoreRecords } from "./bundled/catalog"
import { PackageCatalog, packageKey, packageRecordKey } from "./packages/catalog"
import type { InstalledPackageStore } from "./packages/installed/store"
import type { InstallResult } from "./packages/install/installer"
import type { InstalledPackageRecord, PackageKey, PackageSource } from "./packages/types"
import type { PackageIdentity } from "../core/types"

export type RuntimePackageIdentity = {
  readonly id: string
  readonly version: string
  /** In-memory compatibility/display metadata; never persisted. */
  readonly name?: string
}

export type PackageActivationState = "installed" | "activating" | "active" | "failed" | "disposed"

export type PackageActivationStatus = {
  readonly key: PackageKey
  readonly id: string
  readonly version: string
  readonly source: PackageSource
  readonly state: PackageActivationState
  readonly error?: string
}

export type PackageRuntimeDiagnostic = {
  readonly key: PackageKey
  readonly phase: "activation" | "conflict" | "removal"
  readonly message: string
}

type ActivationHost = Pick<TypeSystemHost, "activate" | "isActive" | "activePackages">

/** Coordinates exact package activation without owning graph state. */
export class PackageActivationCoordinator {
  private readonly statuses = new Map<PackageKey, PackageActivationStatus>()
  private readonly inflight = new Map<PackageKey, Promise<PackageActivationStatus>>()
  private readonly activeById = new Map<string, PackageKey>()
  private disposed = false

  constructor(private readonly host: ActivationHost, private readonly catalog: PackageCatalog) {
    for (const record of catalog.records()) {
      const key = packageRecordKey(record as InstalledPackageRecord)
      this.statuses.set(key, {
        key,
        id: record.manifest.id,
        version: record.manifest.version,
        source: "source" in record ? record.source : "external",
        state: "installed",
      })
    }
    for (const active of host.activePackages()) {
      const key = packageKey(active.id, active.version)
      this.activeById.set(active.id, key)
      this.statuses.set(key, { key, id: active.id, version: active.version, source: "bundled", state: "active" })
    }
  }

  status(key: PackageKey): PackageActivationStatus | undefined { return this.statuses.get(key) }
  states(): readonly PackageActivationStatus[] { return [...this.statuses.values()].sort((a, b) => a.key.localeCompare(b.key)) }

  async activate(identity: RuntimePackageIdentity, options: { readonly retry?: boolean } = {}): Promise<PackageActivationStatus> {
    if (this.disposed) throw new Error("package activation coordinator is disposed")
    const key = packageKey(identity.id, identity.version)
    const packageInfo = this.catalog.getExact(key)
    if (!packageInfo) return this.fail(key, identity, `package '${key}' is not installed`)

    const current = this.statuses.get(key)
    if (current?.state === "active") return current
    if (current?.state === "failed" && options.retry !== true) throw new Error(current.error ?? `package '${key}' activation previously failed`)
    const activeKey = this.activeById.get(identity.id)
    if (activeKey && activeKey !== key) return this.fail(key, identity, `package ID '${identity.id}' is already active as '${activeKey}'`)
    const pending = this.inflight.get(key)
    if (pending) return pending
    this.statuses.set(key, { key, id: identity.id, version: identity.version, source: "source" in packageInfo ? packageInfo.source : "external", state: "activating" })
    const request = this.runActivation(key, identity)
    this.inflight.set(key, request)
    try { return await request } finally { this.inflight.delete(key) }
  }

  /** Reconciliation makes one attempt per exact reference and never retries a failed state. */
  async reconcile(identities: readonly RuntimePackageIdentity[]): Promise<readonly PackageRuntimeDiagnostic[]> {
    const unique = [...new Map(identities.map((identity) => [packageKey(identity.id, identity.version), identity])).values()]
    const outcomes = await Promise.allSettled(unique.map((identity) => this.activate(identity, { retry: false })))
    return outcomes.flatMap((outcome, index) => outcome.status === "fulfilled" && outcome.value.state !== "failed" ? [] : [{
      key: packageKey(unique[index]!.id, unique[index]!.version),
      phase: "activation" as const,
      message: outcome.status === "fulfilled" ? (outcome.value.error ?? "activation failed") : outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
    }])
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.inflight.values()])
    for (const [key, status] of this.statuses) {
      if (status.state === "active" || status.state === "activating") this.statuses.set(key, { ...status, state: "disposed" })
    }
  }

  private async runActivation(key: PackageKey, identity: RuntimePackageIdentity): Promise<PackageActivationStatus> {
    try {
      const hostIdentity: PackageIdentity = { id: identity.id, version: identity.version, name: identity.name ?? identity.id }
      await this.host.activate(hostIdentity)
      if (!this.host.isActive(hostIdentity)) throw new Error(`host activated a different version for '${key}'`)
      const current = this.statuses.get(key)!
      const active = { ...current, state: "active" as const }
      this.activeById.set(identity.id, key)
      this.statuses.set(key, active)
      return active
    } catch (cause) {
      return this.fail(key, identity, cause instanceof Error ? cause.message : String(cause))
    }
  }

  private fail(key: PackageKey, identity: RuntimePackageIdentity, message: string): PackageActivationStatus {
    const current = this.statuses.get(key)
    const failed: PackageActivationStatus = { key, id: identity.id, version: identity.version, source: current?.source ?? "external", state: "failed", error: message }
    this.statuses.set(key, failed)
    return failed
  }
}

export type EditorTypeSystemRuntimeOptions = {
  readonly store?: InstalledPackageStore
  readonly external?: readonly InstalledPackageRecord[]
  /** Test/integration seam for a precomputed bundled catalog. */
  readonly bundled?: readonly InstalledPackageRecord[]
}

/** Frontend lifecycle owner for package inference and runtime reconciliation. */
export class EditorTypeSystemRuntime {
  private constructor(
    private host: TypeSystemHost,
    private scheduler: PackageGraphScheduler,
    private catalog: PackageCatalog,
    private readonly bundled: readonly InstalledPackageRecord[],
    private readonly store?: InstalledPackageStore,
    private coordinator = new PackageActivationCoordinator(host, catalog),
  ) {}

  static async create(options: EditorTypeSystemRuntimeOptions = {}): Promise<EditorTypeSystemRuntime> {
    const bundled = options.bundled ?? await bundledCoreRecords()
    const external = options.external ?? (options.store ? await options.store.list() : [])
    const catalog = PackageCatalog.compose(bundled, external)
    const selections: PackageSelection[] = catalog.records().map((record) => ({ resources: record.resources }))
    const host = await TypeSystemHost.create(selections)
    const runtime = new EditorTypeSystemRuntime(host, new PackageGraphScheduler(host), catalog, bundled, options.store)
    await runtime.bootstrap()
    return runtime
  }

  infer(snapshot: TypeGraphSnapshot): GraphInferenceResult { return this.scheduler.infer(snapshot) }
  packages(): ActivePackageMetadata[] { return this.host.activePackages() }
  availablePackages(): ActivePackageMetadata[] { return this.catalog.records().map(toMetadata) }
  activationState(key: PackageKey): PackageActivationStatus | undefined { return this.coordinator.status(key) }
  activationStates(): readonly PackageActivationStatus[] { return this.coordinator.states() }
  isReady(): boolean { return this.bundled.every((record) => this.coordinator.status(record.key)?.state === "active") }
  diagnostics(): readonly PackageRuntimeDiagnostic[] { return this.coordinator.states().filter((status) => status.state === "failed").map((status) => ({ key: status.key, phase: "activation", message: status.error ?? "activation failed" })) }

  activate(identity: RuntimePackageIdentity, options?: { readonly retry?: boolean }): Promise<PackageActivationStatus> { return this.coordinator.activate(identity, options) }
  reconcile(identities: readonly RuntimePackageIdentity[]): Promise<readonly PackageRuntimeDiagnostic[]> { return this.coordinator.reconcile(identities) }

  /** Consume T05's post-persistence result and make the package immediately usable. */
  async install(result: Extract<InstallResult, { status: "installed" | "already-installed" }>): Promise<PackageActivationStatus> {
    if (this.store) await this.store.put(result.record)
    const external = [...this.catalog.records().filter((record) => "source" in record && record.source === "external" && record.key !== result.key), result.record]
    await this.rebuild(external.filter((record): record is InstalledPackageRecord => "source" in record))
    return this.activate(result.activationRequest, { retry: true })
  }

  async remove(key: PackageKey, referencedKeys: readonly PackageKey[] = []): Promise<void> {
    const record = this.catalog.getExact(key)
    if (!record || !("source" in record) || record.source !== "external") throw new Error(`package '${key}' cannot be removed`)
    if (this.coordinator.status(key)?.state === "active") throw new Error(`package '${key}' is active and cannot be removed during this session`)
    if (referencedKeys.includes(key)) throw new Error(`package '${key}' is referenced by the current diagram`)
    const externalRecords = this.catalog.records().filter((candidate): candidate is InstalledPackageRecord => "key" in candidate && candidate.source === "external")
    const dependent = externalRecords.find((candidate) => Object.values(candidate.resolvedDependencies).includes(key))
    if (dependent) throw new Error(`package '${key}' is required by installed package '${dependent.key}'`)
    const next = this.catalog.records().filter((candidate) => packageRecordKey(candidate as InstalledPackageRecord) !== key).filter((candidate): candidate is InstalledPackageRecord => "key" in candidate)
    if (this.store) await this.store.delete(key)
    await this.rebuild(next)
  }

  async dispose(): Promise<void> { await this.coordinator.dispose(); await this.host.dispose() }

  private async bootstrap(): Promise<void> {
    await Promise.allSettled(this.bundled.map((record) => this.activate({ id: record.manifest.id, version: record.manifest.version }, { retry: true })))
  }

  private async rebuild(external: readonly InstalledPackageRecord[]): Promise<void> {
    const nextCatalog = PackageCatalog.compose(this.bundled, external)
    const nextHost = await TypeSystemHost.create(nextCatalog.records().map((record) => ({ resources: record.resources })))
    const previousHost = this.host
    this.host = nextHost
    this.catalog = nextCatalog
    this.scheduler = new PackageGraphScheduler(nextHost)
    this.coordinator = new PackageActivationCoordinator(nextHost, nextCatalog)
    await this.bootstrap()
    await previousHost.dispose()
  }
}

function toMetadata(record: InstalledPackageRecord | ReturnType<PackageCatalog["records"]>[number]): ActivePackageMetadata {
  return { id: record.manifest.id, version: record.manifest.version, definition: record.definition }
}
