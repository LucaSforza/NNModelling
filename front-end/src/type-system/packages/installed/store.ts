import { immutableRecord, PackageConflictError, packageRecordKey } from "../catalog"
import type { InstalledPackageRecord, PackageKey } from "../types"

export const INSTALLED_PACKAGE_DB_NAME = "nnmodelling-packages"
export const INSTALLED_PACKAGE_DB_VERSION = 1
export const INSTALLED_PACKAGE_OBJECT_STORE = "packages"

export class PackageStoreError extends Error {
  readonly code: "store-open" | "store-transaction" | "store-schema"
  constructor(code: PackageStoreError["code"], message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "PackageStoreError"
    this.code = code
  }
}

export interface InstalledPackageStore {
  list(): Promise<readonly InstalledPackageRecord[]>
  get(key: PackageKey): Promise<InstalledPackageRecord | undefined>
  /** Put the complete record atomically; same digest is idempotent. */
  put(record: InstalledPackageRecord): Promise<InstalledPackageRecord>
  /** Delete one record atomically. Missing records are a no-op. */
  delete(key: PackageKey): Promise<void>
  close?(): void
}

export class InMemoryInstalledPackageStore implements InstalledPackageStore {
  private readonly records = new Map<PackageKey, InstalledPackageRecord>()
  private queue: Promise<void> = Promise.resolve()

  async list(): Promise<readonly InstalledPackageRecord[]> {
    await this.queue
    return [...this.records.values()].sort((left, right) => left.key.localeCompare(right.key)).map(immutableRecord)
  }

  async get(key: PackageKey): Promise<InstalledPackageRecord | undefined> {
    await this.queue
    const record = this.records.get(key)
    return record === undefined ? undefined : immutableRecord(record)
  }

  async put(record: InstalledPackageRecord): Promise<InstalledPackageRecord> {
    return this.serial(async () => {
      const normalized = immutableRecord(record)
      if (normalized.source !== "external") throw new PackageStoreError("store-transaction", "only external packages may be persisted")
      const existing = this.records.get(normalized.key)
      if (existing && existing.digest !== normalized.digest) throw new PackageConflictError(normalized.key)
      this.records.set(normalized.key, existing ?? normalized)
      return immutableRecord(existing ?? normalized)
    })
  }

  async delete(key: PackageKey): Promise<void> {
    await this.serial(async () => { this.records.delete(key) })
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release!: () => void
    this.queue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }
}

export type IndexedDbPackageStoreOptions = {
  readonly indexedDB?: IDBFactory
  readonly databaseName?: string
}

/** IndexedDB v1 adapter. Each public operation owns one complete transaction. */
export class IndexedDbInstalledPackageStore implements InstalledPackageStore {
  private readonly databaseName: string
  private readonly database: Promise<IDBDatabase>
  private closed = false

  constructor(options: IndexedDbPackageStoreOptions | string = {}) {
    const config = typeof options === "string" ? { databaseName: options } : options
    this.databaseName = config.databaseName ?? INSTALLED_PACKAGE_DB_NAME
    const factory = config.indexedDB ?? globalThis.indexedDB
    if (!factory) {
      this.database = Promise.reject(new PackageStoreError("store-open", "IndexedDB is not available"))
    } else {
      this.database = openDatabase(factory, this.databaseName)
    }
  }

  static async open(options: IndexedDbPackageStoreOptions | string = {}): Promise<IndexedDbInstalledPackageStore> {
    const store = new IndexedDbInstalledPackageStore(options)
    await store.ready()
    return store
  }

  async ready(): Promise<void> { await this.database.then(() => undefined) }

  async list(): Promise<readonly InstalledPackageRecord[]> {
    return this.transaction("readonly", (objectStore) => request(objectStore.getAll()).then((values) => values.map(deserialize).sort((a, b) => a.key.localeCompare(b.key))))
  }

  async get(key: PackageKey): Promise<InstalledPackageRecord | undefined> {
    return this.transaction("readonly", (objectStore) => request(objectStore.get(key)).then((value) => value === undefined ? undefined : deserialize(value)))
  }

  async put(record: InstalledPackageRecord): Promise<InstalledPackageRecord> {
    const normalized = immutableRecord(record)
    if (normalized.source !== "external") throw new PackageStoreError("store-transaction", "only external packages may be persisted")
    return this.transaction("readwrite", async (objectStore) => {
      const current = await request<StoredPackageRecord | undefined>(objectStore.get(normalized.key))
      if (current && current.digest !== normalized.digest) throw new PackageConflictError(normalized.key)
      const result = current === undefined ? normalized : deserialize(current)
      await request(objectStore.put(serialize(result)))
      return immutableRecord(result)
    })
  }

  async delete(key: PackageKey): Promise<void> {
    await this.transaction("readwrite", (objectStore) => request(objectStore.delete(key)).then(() => undefined))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    void this.database.then((database) => database.close())
  }

  private async transaction<T>(mode: IDBTransactionMode, operation: (objectStore: IDBObjectStore) => Promise<T>): Promise<T> {
    if (this.closed) throw new PackageStoreError("store-transaction", "package store is closed")
    let transaction: IDBTransaction
    try {
      const database = await this.database
      transaction = database.transaction(INSTALLED_PACKAGE_OBJECT_STORE, mode)
    } catch (cause) {
      throw new PackageStoreError("store-transaction", "could not open package store transaction", { cause })
    }
    try {
      const completion = transactionComplete(transaction)
      const value = await operation(transaction.objectStore(INSTALLED_PACKAGE_OBJECT_STORE))
      await completion
      return value
    } catch (cause) {
      try { transaction.abort() } catch { /* already completed */ }
      if (cause instanceof PackageConflictError) throw cause
      throw new PackageStoreError("store-transaction", "package store transaction failed", { cause })
    }
  }
}

export {
  InMemoryInstalledPackageStore as MemoryInstalledPackageStore,
  InMemoryInstalledPackageStore as InMemoryPackageStore,
  IndexedDbInstalledPackageStore as IndexedDBPackageStore,
  IndexedDbInstalledPackageStore as IndexedDBInstalledPackageStore,
}

type StoredPackageRecord = {
  readonly key: PackageKey
  readonly source: "external"
  readonly manifest: InstalledPackageRecord["manifest"]
  readonly definition: InstalledPackageRecord["definition"]
  readonly resources: Readonly<Record<string, ArrayBuffer>>
  readonly digest: string
  readonly resolvedDependencies: InstalledPackageRecord["resolvedDependencies"]
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest
    try { request = factory.open(name, INSTALLED_PACKAGE_DB_VERSION) }
    catch (cause) { reject(new PackageStoreError("store-open", "could not open package database", { cause })); return }
    request.onupgradeneeded = () => {
      try {
        if (!request.result.objectStoreNames.contains(INSTALLED_PACKAGE_OBJECT_STORE)) request.result.createObjectStore(INSTALLED_PACKAGE_OBJECT_STORE, { keyPath: "key" })
      } catch (cause) { reject(new PackageStoreError("store-schema", "could not create package store schema", { cause })) }
    }
    request.onsuccess = () => {
      if (!request.result.objectStoreNames.contains(INSTALLED_PACKAGE_OBJECT_STORE)) {
        request.result.close()
        reject(new PackageStoreError("store-schema", "package database has no v1 object store"))
        return
      }
      resolve(request.result)
    }
    request.onerror = () => reject(new PackageStoreError("store-open", "could not open package database", { cause: request.error ?? undefined }))
    request.onblocked = () => reject(new PackageStoreError("store-open", "package database open was blocked"))
  })
}

function serialize(record: InstalledPackageRecord): StoredPackageRecord {
  const resources: Record<string, ArrayBuffer> = {}
  for (const [path, value] of Object.entries(record.resources)) resources[path] = value.slice().buffer
  return { key: record.key, source: "external", manifest: structuredClone(record.manifest), definition: structuredClone(record.definition), resources, digest: record.digest, resolvedDependencies: structuredClone(record.resolvedDependencies) }
}

function deserialize(value: StoredPackageRecord): InstalledPackageRecord {
  const resources: Record<string, Uint8Array> = {}
  for (const [path, bytes] of Object.entries(value.resources)) resources[path] = new Uint8Array(bytes.slice(0))
  return immutableRecord({ key: value.key, source: value.source, manifest: value.manifest, definition: value.definition, resources, digest: value.digest, resolvedDependencies: value.resolvedDependencies })
}

function request<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"))
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"))
  })
}
