import { afterEach, describe, expect, test } from "vitest"

import { TypeSystemHost } from "../type-system/host"
import type { PackageSelection } from "../type-system/host"

const hosts: TypeSystemHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.dispose()
})

describe("public package lifecycle", () => {
  test("activates dependencies before the selected package and clears all registrations on host disposal", async () => {
    const host = await createHost([
      selection("test.lifecycle-dependency", {}, identityLua),
      selection("test.lifecycle-app", { "test.lifecycle-dependency": "1.0.0" }, identityLua),
    ])

    await host.activate("test.lifecycle-app")

    expect(host.activePackages().map(({ id }) => id)).toEqual([
      "test.lifecycle-dependency",
      "test.lifecycle-app",
    ])
    expect(host.isActive("test.lifecycle-dependency")).toBe(true)
    expect(host.isActive("test.lifecycle-app")).toBe(true)
    expect(host.inferForEditor("test.lifecycle-app", {
      kind: "layer",
      inputs: [{ shape: ["B", 4], dtype: "float32" }],
    }, {})).toEqual({ status: "success", output: { shape: ["B", 4], dtype: "float32" } })

    await host.dispose()
    await host.dispose()

    expect(host.activePackages()).toEqual([])
    expect(host.isActive("test.lifecycle-dependency")).toBe(false)
    expect(host.isActive("test.lifecycle-app")).toBe(false)
  })

  test("keeps semantic incompatibility as an error and Lua exceptions as a fault", async () => {
    const host = await createHost([selection("test.faulting", {}, throwingLua)])
    await host.activate("test.faulting")

    expect(host.inferForEditor("test.faulting", {
      kind: "input",
      inputs: [],
    }, {})).toEqual({
      status: "error",
      message: "package 'test.faulting' requires layer",
    })

    const fault = host.inferForEditor("test.faulting", {
      kind: "layer",
      inputs: [{ shape: ["B", 4], dtype: "float32" }],
    }, {})
    expect(fault.status).toBe("fault")
    if (fault.status !== "fault") throw new Error("expected a host fault")
    expect(fault.fault).toEqual({
      packageId: "test.faulting",
      phase: "inference",
      message: expect.stringContaining("test.faulting@1.0.0 (inference.lua)"),
    })
  })

  test("rejects activation failures without leaving an active package", async () => {
    const host = await createHost([selection("test.missing-runtime-dependency", {
      "test.not-installed": "1.0.0",
    }, identityLua)])

    await expect(host.activate("test.missing-runtime-dependency")).rejects.toThrow(
      "static dependency 'test.not-installed' is missing or incompatible",
    )
    expect(host.activePackages()).toEqual([])
    expect(host.isActive("test.missing-runtime-dependency")).toBe(false)
  })
})

async function createHost(packages: readonly PackageSelection[]): Promise<TypeSystemHost> {
  const host = await TypeSystemHost.create(packages)
  hosts.push(host)
  return host
}

function selection(
  id: string,
  dependencies: Readonly<Record<string, string>>,
  inference: string,
  version = "1.0.0",
): PackageSelection {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    id,
    version,
    dependencies,
    entrypoints: {
      definition: "stereotype.json",
      inference: { language: "lua", file: "inference.lua" },
    },
  })
  const definition = JSON.stringify({
    name: id,
    kind: "layer",
    view: { color: "#123456", width: 100, height: 60 },
    parameters: {},
  })
  return {
    resources: {
      "manifest.json": manifest,
      "stereotype.json": definition,
      "inference.lua": inference,
    },
  }
}

const identityLua = `
return function(context)
  return { status = "success", output = context.inputs[1] }
end
`

const throwingLua = `
return function()
  error("synthetic inference failure")
end
`
