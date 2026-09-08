import { Context } from "cordis"
import { afterEach, describe, expect, test } from "vitest"

import { PackageCatalog } from "../type-system/packages/catalog"
import { LuaInferenceService, PackageRegistryService } from "../type-system/packages/cordis-services"
import { PackageLoader } from "../type-system/packages/loader"
import type {
  InferenceRule,
  InferenceRuntime,
  LoadedInferenceRule,
  PackageBundle,
} from "../type-system/packages/types"

const contexts: Context[] = []

afterEach(async () => {
  for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
})

describe("Cordis package activation contract", () => {
  test("fails activation when a required host service is absent", async () => {
    const context = new Context()
    contexts.push(context)
    const loader = new PackageLoader(context, PackageCatalog.fromBundles([bundle("test.service-check", {}, "rule")]))

    await expect(loader.load(ref("test.service-check"))).rejects.toThrow("packageRegistry")

    new PackageRegistryService(context)
    await expect(loader.load(ref("test.service-check"))).rejects.toThrow("luaInference")
  })

  test("activates static dependencies first and disposes them in reverse order", async () => {
    const events: string[] = []
    const { loader, registry, context } = createLoader([
      bundle("test.dep", {}, "dep-rule"),
      bundle("test.app", { "test.dep": "1.0.0" }, "app-rule"),
    ], events)

    const lease = await loader.load(ref("test.app"))

    expect(context.registry.size).toBe(2)
    expect(events).toEqual(["load:test.dep", "load:test.app"])
    expect([...registry.values()].map(({ packageInfo }) => packageInfo.manifest.id)).toEqual([
      "test.dep",
      "test.app",
    ])

    await lease.dispose()

    expect(events).toEqual([
      "load:test.dep",
      "load:test.app",
      "dispose:test.app",
      "dispose:test.dep",
    ])
    expect(registry.has("test.dep")).toBe(false)
    expect(registry.has("test.app")).toBe(false)
    expect(context.registry.size).toBe(0)
  })

  test("shares one loaded rule across leases and releases it once", async () => {
    const events: string[] = []
    const { loader, registry } = createLoader([bundle("test.shared", {}, "shared-rule")], events)

    const first = await loader.load(ref("test.shared"))
    const second = await loader.load(ref("test.shared"))

    expect(events).toEqual(["load:test.shared"])
    expect(registry.has("test.shared")).toBe(true)

    await first.dispose()
    await first.dispose()
    expect(events).toEqual(["load:test.shared"])
    expect(registry.has("test.shared")).toBe(true)

    await second.dispose()
    await second.dispose()
    expect(events).toEqual(["load:test.shared", "dispose:test.shared"])
    expect(registry.has("test.shared")).toBe(false)
  })

  test("rolls back a failed dependency, cycle, or Lua load without active packages", async () => {
    const cases: Array<{
      name: string
      bundles: PackageBundle[]
      expected: string
      failingId: string
      expectedDisposals: number
    }> = [
      {
        name: "missing dependency",
        bundles: [bundle("test.missing-user", { "test.missing": "1.0.0" }, "rule")],
        expected: "static dependency 'test.missing' is missing or incompatible",
        failingId: "test.missing-user",
        expectedDisposals: 0,
      },
      {
        name: "incompatible dependency",
        bundles: [
          bundle("test.v2", {}, "dep-rule", "2.0.0"),
          bundle("test.incompatible-user", { "test.v2": "^1.0.0" }, "rule"),
        ],
        expected: "static dependency 'test.v2' is missing or incompatible",
        failingId: "test.incompatible-user",
        expectedDisposals: 0,
      },
      {
        name: "static cycle",
        bundles: [
          bundle("test.cycle-a", { "test.cycle-b": "1.0.0" }, "rule"),
          bundle("test.cycle-b", { "test.cycle-a": "1.0.0" }, "rule"),
        ],
        expected: "static dependency cycle",
        failingId: "test.cycle-a",
        expectedDisposals: 0,
      },
      {
        name: "Lua load failure",
        bundles: [
          bundle("test.load-dep", {}, "dep-rule"),
          bundle("test.load-failure", { "test.load-dep": "1.0.0" }, "rule"),
        ],
        expected: "test.load-failure load failed",
        failingId: "test.load-failure",
        expectedDisposals: 1,
      },
    ]

    for (const scenario of cases) {
      const events: string[] = []
      const { loader, registry } = createLoader(scenario.bundles, events, scenario.name === "Lua load failure" ? scenario.failingId : undefined)

      await expect(loader.load(ref(scenario.failingId))).rejects.toThrow(scenario.expected)
      expect([...registry.values()]).toHaveLength(0)
      expect(events.filter(event => event.startsWith("dispose:"))).toHaveLength(scenario.expectedDisposals)
    }
  })

  test("disposes a loaded rule when registry activation rejects a duplicate ID", async () => {
    const context = new Context()
    contexts.push(context)
    new PackageRegistryService(context)
    const events: string[] = []
    new LuaInferenceService(context, runtime(events))
    const registry = context.packageRegistry
    const first = new PackageLoader(context, PackageCatalog.fromBundles([bundle("test.duplicate", {}, "first-rule", "1.0.0")]))
    const second = new PackageLoader(context, PackageCatalog.fromBundles([bundle("test.duplicate", {}, "second-rule", "2.0.0")]))

    await first.load(ref("test.duplicate"))
    await expect(second.load(ref("test.duplicate", "2.0.0"))).rejects.toThrow("already active")

    expect(registry.get("test.duplicate")?.packageInfo.manifest.version).toBe("1.0.0")
    expect(events).toEqual(["load:test.duplicate", "load:test.duplicate", "dispose:test.duplicate"])
  })
})

function createLoader(
  bundles: readonly PackageBundle[],
  events: string[],
  failingId?: string,
) {
  const context = new Context()
  contexts.push(context)
  new PackageRegistryService(context)
  const registry = context.packageRegistry
  const loader = new PackageLoader(
    context,
    PackageCatalog.fromBundles(bundles),
  )
  new LuaInferenceService(context, runtime(events, failingId))
  return { loader, registry, context }
}

function runtime(events: string[], failingId?: string): InferenceRuntime {
  return {
    async load(packageInfo): Promise<LoadedInferenceRule> {
      const id = packageInfo.manifest.id
      events.push(`load:${id}`)
      if (id === failingId) throw new Error(`${id} load failed`)
      return {
        infer: identityRule,
        dispose: () => { events.push(`dispose:${id}`) },
      }
    },
  }
}

const identityRule: InferenceRule = (context) => ({
  status: "success",
  output: context.inputs[0]!,
})

function bundle(
  id: string,
  dependencies: Readonly<Record<string, string>>,
  inferenceFile: string,
  version = "1.0.0",
): PackageBundle {
  const manifest = {
    schemaVersion: 1 as const,
    id,
    version,
    dependencies,
    entrypoints: {
      definition: "stereotype.json",
      inference: { language: "lua" as const, file: inferenceFile },
    },
  }
  const definition = {
    name: id,
    kind: "layer" as const,
    view: { color: "#123456", width: 100, height: 60 },
    parameters: {},
  }
  return { manifest, definition, resources: {} }
}

function ref(id: string, version = "1.0.0") {
  return { id, version, name: id }
}
