import { describe, expect, test } from "vitest"
import manifestText from "../../tests/fixtures/packages/vendor-layer/manifest.json?raw"
import definitionText from "../../tests/fixtures/packages/vendor-layer/stereotype.json?raw"
import inferenceText from "../../tests/fixtures/packages/vendor-layer/inference.lua?raw"
import pytorchText from "../../tests/fixtures/packages/vendor-layer/pytorch.py?raw"
import { bundledCoreRecords } from "../type-system/bundled/catalog"
import { PackageCatalog } from "../type-system/packages/catalog"
import { installLocalPackage, normalizeLocalPackageFiles, readBrowserPackageDirectory, type LocalPackageFile } from "../type-system/packages/install/installer"
import { createInstalledPackageRecord } from "../type-system/packages/installed/records"
import { InMemoryInstalledPackageStore } from "../type-system/packages/installed/store"
import type { Definition, Manifest } from "../type-system/packages/types"

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const fixtureFiles = (): LocalPackageFile[] => [
  { relativePath: "manifest.json", bytes: bytes(manifestText) },
  { relativePath: "stereotype.json", bytes: bytes(definitionText) },
  { relativePath: "inference.lua", bytes: bytes(inferenceText) },
  { relativePath: "pytorch.py", bytes: bytes(pytorchText) },
  { relativePath: "helper.bin", bytes: Uint8Array.from([0, 1, 255, 10]) },
]

async function options(store = new InMemoryInstalledPackageStore()) {
  return { catalog: PackageCatalog.fromRecords(await bundledCoreRecords()), store }
}

describe("local package installer", () => {
  test("normalizes one browser root and preserves every resource byte", async () => {
    const selected = fixtureFiles().map((file) => ({ ...file, relativePath: `vendor-layer/${file.relativePath}` }))
    const normalized = normalizeLocalPackageFiles(selected)
    expect(normalized.map((file) => file.relativePath)).toContain("manifest.json")
    const store = new InMemoryInstalledPackageStore()
    const result = await installLocalPackage(selected, await options(store))
    expect(result.status).toBe("installed")
    if (result.status !== "installed") return
    expect(result.activationRequest).toMatchObject({ id: "vendor.layer", version: "1.0.0", key: "vendor.layer@1.0.0" })
    expect(result.record.resolvedDependencies).toEqual({ "core.input": "core.input@0.1.0" })
    expect([...result.record.resources["helper.bin"]!]).toEqual([0, 1, 255, 10])
    expect([...((await store.get(result.key))?.resources["pytorch.py"] ?? [])]).toEqual([...bytes(pytorchText)])
  })

  test("same bytes are idempotent and changed bytes are rejected without writes", async () => {
    const store = new InMemoryInstalledPackageStore()
    const config = await options(store)
    const first = await installLocalPackage(fixtureFiles(), config)
    expect(first.status).toBe("installed")
    const second = await installLocalPackage(fixtureFiles(), config)
    expect(second.status).toBe("already-installed")
    const changed = fixtureFiles().map((file) => file.relativePath === "pytorch.py" ? { ...file, bytes: bytes("changed") } : file)
    const rejected = await installLocalPackage(changed, config)
    expect(rejected).toMatchObject({ status: "rejected", diagnostic: { code: "changed-duplicate", phase: "digest" } })
    expect((await store.list())).toHaveLength(1)
  })

  test("rejects malformed definitions and missing Python/Lua entrypoints before persistence", async () => {
    const store = new InMemoryInstalledPackageStore()
    const config = await options(store)
    const malformed = fixtureFiles().map((file) => file.relativePath === "stereotype.json" ? { ...file, bytes: bytes("{") } : file)
    expect(await installLocalPackage(malformed, config)).toMatchObject({ status: "rejected", diagnostic: { code: "malformed-definition" } })
    const missing = fixtureFiles().filter((file) => file.relativePath !== "pytorch.py")
    expect(await installLocalPackage(missing, config)).toMatchObject({ status: "rejected", diagnostic: { code: "missing-entrypoint" } })
    expect(await store.list()).toHaveLength(0)
  })

  test("distinguishes missing and ambiguous dependencies", async () => {
    const store = new InMemoryInstalledPackageStore()
    const config = await options(store)
    const missingManifest = JSON.parse(manifestText) as Manifest
    missingManifest.dependencies = { "vendor.missing": "1.0.0" }
    const missing = withManifest(missingManifest)
    expect(await installLocalPackage(missing, config)).toMatchObject({ status: "rejected", diagnostic: { code: "dependency-missing", dependency: { id: "vendor.missing" } } })

    const candidateManifest = { ...missingManifest, id: "vendor.depender", dependencies: { "vendor.versioned": "^1.0.0" } }
    const first = await packageRecord("vendor.versioned", "1.0.0")
    const second = await packageRecord("vendor.versioned", "1.1.0")
    const ambiguousConfig = { catalog: PackageCatalog.fromRecords([...await bundledCoreRecords(), first, second]), store }
    expect(await installLocalPackage(withManifest(candidateManifest), ambiguousConfig)).toMatchObject({ status: "rejected", diagnostic: { code: "dependency-ambiguous", dependency: { id: "vendor.versioned" } } })
    expect(await store.list()).toHaveLength(0)
  })

  test("detects dependency cycles and bundled ID collisions", async () => {
    const store = new InMemoryInstalledPackageStore()
    const cycleDependency = await packageRecord("vendor.cycle-b", "1.0.0", { "vendor.cycle-a": "1.0.0" }, { "vendor.cycle-a": "vendor.cycle-a@1.0.0" })
    const config = { catalog: PackageCatalog.fromRecords([...await bundledCoreRecords(), cycleDependency]), store }
    const cycleManifest = { ...JSON.parse(manifestText) as Manifest, id: "vendor.cycle-a", dependencies: { "vendor.cycle-b": "1.0.0" } }
    expect(await installLocalPackage(withManifest(cycleManifest), config)).toMatchObject({ status: "rejected", diagnostic: { code: "dependency-cycle" } })
    const collisionManifest = { ...JSON.parse(manifestText) as Manifest, id: "core.input", dependencies: {} }
    expect(await installLocalPackage(withManifest(collisionManifest), await options(store))).toMatchObject({ status: "rejected", diagnostic: { code: "bundled-id-collision" } })
    expect(await store.list()).toHaveLength(0)
  })

  test("browser adapter hides DOM File paths from the use case", async () => {
    const files = fixtureFiles().map((file) => ({ name: file.relativePath, webkitRelativePath: `vendor-layer/${file.relativePath}`, arrayBuffer: async () => file.bytes.buffer }))
    const normalized = await readBrowserPackageDirectory(files as unknown as FileList)
    expect(normalized[0]?.relativePath).toBe("manifest.json")
    expect(normalized[0]?.bytes).toBeInstanceOf(Uint8Array)
  })
})

function withManifest(manifest: Manifest): LocalPackageFile[] {
  return fixtureFiles().map((file) => file.relativePath === "manifest.json" ? { ...file, bytes: bytes(JSON.stringify(manifest)) } : file)
}

async function packageRecord(id: string, version: string, dependencies: Readonly<Record<string, string>> = {}, resolvedDependencies: Readonly<Record<string, `${string}@${string}`>> = {}) {
  const manifest: Manifest = { schemaVersion: 1, id, version, dependencies, entrypoints: { definition: "stereotype.json", inference: { language: "lua", file: "inference.lua" }, pytorch: { language: "python", file: "pytorch.py" } } }
  const definition: Definition = { name: id, kind: "layer", view: { color: "#123456", width: 100, height: 50 }, parameters: {} }
  return createInstalledPackageRecord({ source: "external", manifest, definition, resolvedDependencies, resources: { "manifest.json": JSON.stringify(manifest), "stereotype.json": JSON.stringify(definition), "inference.lua": "return function() end", "pytorch.py": "class Package: pass" } })
}
