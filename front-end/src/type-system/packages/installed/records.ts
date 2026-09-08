import { immutableRecord, packageRecordKey } from "../catalog"
import type { Definition, InstalledPackageRecord, Manifest, PackageResourceMap, PackageResourceProvider, PackageSource } from "../types"

/** Create a catalog record from already validated package metadata and bytes. */
export async function createInstalledPackageRecord(input: {
  readonly source: PackageSource
  readonly manifest: Manifest
  readonly definition: Definition
  readonly resources: PackageResourceMap
  readonly resolvedDependencies?: Readonly<Record<string, InstalledPackageRecord["key"]>>
}): Promise<InstalledPackageRecord> {
  const resources: Record<string, Uint8Array> = {}
  for (const [path, value] of Object.entries(input.resources)) resources[path] = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value)
  for (const path of [input.manifest.entrypoints.definition, input.manifest.entrypoints.inference?.file, input.manifest.entrypoints.pytorch?.file]) {
    if (path !== undefined && resources[path] === undefined) throw new Error(`package resource '${path}' is missing`)
  }
  if (input.definition.kind === "input" && input.manifest.entrypoints.pytorch) throw new Error("input packages must not define a PyTorch entrypoint")
  const record: InstalledPackageRecord = {
    key: packageRecordKey(input),
    source: input.source,
    manifest: input.manifest,
    definition: input.definition,
    resources,
    digest: await digestResources(resources),
    resolvedDependencies: input.resolvedDependencies ?? {},
  }
  return immutableRecord(record)
}

export const createInstalledRecord = createInstalledPackageRecord
export const makeInstalledPackageRecord = createInstalledPackageRecord

/** Compute a stable digest over path names, lengths, and exact bytes. */
export async function digestResources(resources: Readonly<Record<string, Uint8Array>>): Promise<string> {
  const chunks: Uint8Array[] = []
  for (const path of Object.keys(resources).sort()) {
    const pathBytes = new TextEncoder().encode(path)
    const bytes = resources[path]!
    const length = new TextEncoder().encode(String(bytes.byteLength))
    chunks.push(pathBytes, new Uint8Array([0]), length, new Uint8Array([0]), bytes, new Uint8Array([0]))
  }
  const input = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.byteLength }
  if (globalThis.crypto?.subtle?.digest) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", input)
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }
  // Older test/browser environments may not expose Web Crypto. This fallback
  // remains deterministic and is only used as an internal content identity.
  let hash = 0xcbf29ce484222325n
  for (const byte of input) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n) }
  return hash.toString(16).padStart(16, "0")
}

/** Enumerate an object resource map without leaking provider implementation details. */
export function resourceBytes(resources: PackageResourceMap | PackageResourceProvider): Promise<Readonly<Record<string, Uint8Array>>> {
  if ("read" in resources) return Promise.reject(new Error("a resource provider cannot produce a complete installed record"))
  const bytes: Record<string, Uint8Array> = {}
  for (const [path, value] of Object.entries(resources)) bytes[path] = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value)
  return Promise.resolve(bytes)
}

/** Read-only seam shared by bundled and installed package consumers. */
export function installedResourceProvider(record: InstalledPackageRecord): PackageResourceProvider {
  return {
    read: (path) => {
      const bytes = record.resources[path]
      if (bytes === undefined) throw new Error(`package resource '${path}' is missing`)
      return new Uint8Array(bytes)
    },
  }
}
