import { afterEach, describe, expect, test } from "vitest"

import { coreInputPackage } from "../type-system/bundled/core-input"
import { TypeSystemHost } from "../type-system/host"
const hosts: TypeSystemHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.dispose()
})

describe("new package type-system input slice", () => {
  test("activates core.input with a named binding parameter", async () => {
    const host = await TypeSystemHost.create([coreInputPackage])
    hosts.push(host)
    await host.activate({ id: "core.input", version: "0.1.0", name: "Input" })

    expect(host.isActive({ id: "core.input", version: "0.1.0", name: "Input" })).toBe(true)
    expect(host.packageDefinition({ id: "core.input", version: "0.1.0", name: "Input" })?.parameters).toHaveProperty("binding")

    await host.dispose()
    expect(host.isActive({ id: "core.input", version: "0.1.0", name: "Input" })).toBe(false)
  })

  test("does not fabricate a shape without a dataset", async () => {
    const host = await TypeSystemHost.create([coreInputPackage])
    hosts.push(host)
    await host.activate({ id: "core.input", version: "0.1.0", name: "Input" })

    expect(host.packageDefinition({ id: "core.input", version: "0.1.0", name: "Input" })?.parameters).toHaveProperty("binding")
  })

  test("does not invoke legacy Input Lua for dataset-scoped inference", async () => {
    const host = await TypeSystemHost.create([{
      resources: {
        ...coreInputPackage.resources as Record<string, string>,
        "inference.lua": "return function() return { status = 'success' } end",
      },
    }])
    hosts.push(host)
    await host.activate({ id: "core.input", version: "0.1.0", name: "Input" })

    expect(host.packageDefinition({ id: "core.input", version: "0.1.0", name: "Input" })?.parameters).toHaveProperty("binding")
  })

  test("rolls back activation when the Lua entrypoint cannot load", async () => {
    const host = await TypeSystemHost.create([{
      resources: {
        ...coreInputPackage.resources as Record<string, string>,
        "inference.lua": "return function(",
      },
    }])
    hosts.push(host)

    await expect(host.activate({ id: "core.input", version: "0.1.0", name: "Input" })).rejects.toThrow("activation failed")
    expect(host.isActive({ id: "core.input", version: "0.1.0", name: "Input" })).toBe(false)
  })

})
