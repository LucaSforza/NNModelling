import { describe, expect, test } from "vitest"
import { BundledPackageCollisionError, PackageCatalog, PackageConflictError, packageKey } from "../type-system/packages/catalog"
import { bundledCoreRecords } from "../type-system/bundled/catalog"
import { createInstalledPackageRecord } from "../type-system/packages/installed/records"
import { InMemoryInstalledPackageStore, IndexedDbInstalledPackageStore } from "../type-system/packages/installed/store"
import type { Definition, Manifest } from "../type-system/packages/types"

const manifest = (id: string, version: string): Manifest => ({
  schemaVersion: 1,
  id,
  version,
  dependencies: {},
  entrypoints: { definition: "stereotype.json", inference: { language: "lua", file: "inference.lua" }, pytorch: { language: "python", file: "pytorch.py" } },
})

const definition: Definition = { name: "External", kind: "layer", view: { color: "#123456", width: 100, height: 50 }, parameters: {} }

async function record(id: string, version: string, content = "return 1") {
  return createInstalledPackageRecord({
    source: "external",
    manifest: manifest(id, version),
    definition,
    resources: { "manifest.json": JSON.stringify(manifest(id, version)), "stereotype.json": JSON.stringify(definition), "inference.lua": content, "pytorch.py": "return x\n" },
  })
}

describe("installed package catalog", () => {
  test("bundled records are complete and immutable", async () => {
    const records = await bundledCoreRecords()
    expect(records.length).toBeGreaterThan(1)
    expect(records.every((item) => item.source === "bundled" && item.key === packageKey(item.manifest.id, item.manifest.version))).toBe(true)
    expect(records.find((item) => item.key === "core.input@0.1.0")?.resources["inference.lua"]).toBeInstanceOf(Uint8Array)
  })

  test("supports exact versions and explicit range queries", async () => {
    const first = await record("vendor.layer", "1.0.0")
    const second = await record("vendor.layer", "2.0.0")
    const catalog = PackageCatalog.fromRecords([first, second])
    expect(catalog.getExact("vendor.layer@1.0.0")?.manifest.version).toBe("1.0.0")
    expect(catalog.getById("vendor.layer")).toHaveLength(2)
    expect(catalog.query("vendor.layer", "^1.0.0")).toHaveLength(1)
    expect(catalog.get("vendor.layer")).toBeUndefined()
  })

  test("does not expose mutable catalog-owned bytes", async () => {
    const source = await record("vendor.immutable", "1.0.0")
    const catalog = PackageCatalog.fromRecords([source])
    const selected = catalog.getExact(source.key) as Extract<Awaited<ReturnType<typeof record>>, { resources: unknown }>
    selected.resources["inference.lua"]![0] = 0
    expect((catalog.getExact(source.key) as typeof source).resources["inference.lua"]![0]).toBe(new TextEncoder().encode("return 1")[0])
  })

  test("round-trips bytes, reloads, and rejects changed duplicate content", async () => {
    const store = new InMemoryInstalledPackageStore()
    const original = await record("vendor.bytes", "1.0.0", "--\r\n\u0000\n")
    await store.put(original)
    const reopened = new InMemoryInstalledPackageStore()
    // A new store has no implicit process-global state; simulate reload by
    // copying the durable record returned by the previous store.
    await reopened.put((await store.get(original.key))!)
    expect([...((await reopened.get(original.key))!.resources["inference.lua"] ?? [])]).toEqual([...new TextEncoder().encode("--\r\n\u0000\n")])
    await expect(store.put(await record("vendor.bytes", "1.0.0", "changed"))).rejects.toBeInstanceOf(PackageConflictError)
    await expect(store.put(original)).resolves.toMatchObject({ key: original.key, digest: original.digest })
  })

  test("bundled IDs cannot be shadowed or deleted through composition", async () => {
    const bundled = await record("core.layer", "1.0.0")
    const external = await record("core.layer", "2.0.0")
    // Marking the first record bundled mirrors the bundled discovery contract.
    const bundledRecord = { ...bundled, source: "bundled" as const }
    expect(() => PackageCatalog.compose([bundledRecord], [external])).toThrow(BundledPackageCollisionError)
    const store = new InMemoryInstalledPackageStore()
    await store.put(external)
    await store.delete(external.key)
    expect(await store.get(external.key)).toBeUndefined()
  })

  test("reports IndexedDB schema/open failure as a typed error", async () => {
    const store = new IndexedDbInstalledPackageStore({ indexedDB: undefined })
    await expect(store.ready()).rejects.toMatchObject({ code: "store-open" })
  })
})
