import { describe, expect, test } from "vitest"

import { PackageActivationCoordinator } from "../type-system/editor-runtime"
import { PackageCatalog } from "../type-system/packages/catalog"
import type { ActivePackageMetadata } from "../type-system/host"
import type { PackageBundle } from "../type-system/packages/types"

const identity = (id: string, version = "1.0.0") => ({ id, version, name: id })

function bundle(id: string, version = "1.0.0"): PackageBundle {
  return {
    manifest: {
      schemaVersion: 1,
      id,
      version,
      dependencies: {},
      entrypoints: { definition: "stereotype.json", inference: { language: "lua", file: "inference.lua" } },
    },
    definition: { name: id, kind: "layer", view: { color: "#fff", width: 100, height: 60 }, parameters: {} },
    resources: {},
  }
}

function fakeHost(delay = 0) {
  const active = new Map<string, string>()
  let calls = 0
  const host = {
    async activate(ref: { id: string; version: string }) {
      calls += 1
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      active.set(ref.id, ref.version)
    },
    isActive(ref: { id: string; version: string }) { return active.get(ref.id) === ref.version },
    activePackages(): ActivePackageMetadata[] {
      return [...active].map(([id, version]) => ({ id, version, definition: bundle(id, version).definition }))
    },
  }
  return { host, calls: () => calls }
}

describe("exact package runtime reconciliation", () => {
  test("deduplicates concurrent exact activation requests", async () => {
    const { host, calls } = fakeHost(10)
    const coordinator = new PackageActivationCoordinator(host, PackageCatalog.fromBundles([bundle("vendor.layer")]))
    const results = await Promise.all([coordinator.activate(identity("vendor.layer")), coordinator.activate(identity("vendor.layer"))])
    expect(results[0]?.state).toBe("active")
    expect(results[1]?.state).toBe("active")
    expect(calls()).toBe(1)
  })

  test("activates the requested exact version and rejects a conflicting version", async () => {
    const { host, calls } = fakeHost()
    const coordinator = new PackageActivationCoordinator(host, PackageCatalog.fromBundles([bundle("vendor.layer", "1.0.0"), bundle("vendor.layer", "2.0.0")]))
    const active = await coordinator.activate(identity("vendor.layer", "2.0.0"))
    const result = await coordinator.activate(identity("vendor.layer", "1.0.0"))
    expect(active.state).toBe("active")
    expect(result.state).toBe("failed")
    expect(result.error).toContain("already active")
    expect(calls()).toBe(1)
  })

  test("failed reconciliation is sticky until explicit retry", async () => {
    const host = {
      async activate() { throw new Error("Lua load failed") },
      isActive() { return false },
      activePackages() { return [] as ActivePackageMetadata[] },
    }
    const coordinator = new PackageActivationCoordinator(host, PackageCatalog.fromBundles([bundle("vendor.layer")]))
    const first = await coordinator.activate(identity("vendor.layer"))
    expect(first.state).toBe("failed")
    const diagnostics = await coordinator.reconcile([identity("vendor.layer")])
    expect(diagnostics[0]?.message).toContain("Lua load failed")
  })
})
