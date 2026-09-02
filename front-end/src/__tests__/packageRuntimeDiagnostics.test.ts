import { afterEach, describe, expect, test } from "vitest"

import { PackageRuntimeDiagnosticCollection } from "../type-system/diagnostics"
import { TypeSystemHost } from "../type-system/host"
import { coreInputPackage } from "../type-system/bundled/core-input"

const hosts: TypeSystemHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.dispose()
})

describe("package/runtime diagnostics", () => {
  test("replaces repeated occurrences and resolves recovered inference", () => {
    const diagnostics = new PackageRuntimeDiagnosticCollection()
    diagnostics.record({
      occurrenceId: "inference:test.layer@1.0.0:node",
      phase: "inference",
      packageId: "test.layer",
      packageVersion: "1.0.0",
      nodeId: "node",
      message: "first cause",
    })
    diagnostics.record({
      occurrenceId: "inference:test.layer@1.0.0:node",
      phase: "inference",
      packageId: "test.layer",
      packageVersion: "1.0.0",
      nodeId: "node",
      message: "updated cause",
    })

    expect(diagnostics.snapshot()).toHaveLength(1)
    expect(diagnostics.snapshot()[0]?.message).toBe("updated cause")
    expect(diagnostics.resolve("inference:test.layer@1.0.0:node")).toBe(true)
    expect(diagnostics.snapshot()).toEqual([])
  })

  test("retains the original Lua cause as a fatal inference diagnostic", async () => {
    const host = await TypeSystemHost.create([{
      resources: {
        ...coreInputPackage.resources as Record<string, string>,
        "inference.lua": "return function() error('diagnostic Lua cause') end",
      },
    }])
    hosts.push(host)
    await host.activate({ id: "core.input", version: "0.1.0", name: "Input" })

    const result = host.inferForEditor(
      { id: "core.input", version: "0.1.0", name: "Input" },
      { kind: "input", inputs: [] },
      { shape: ["B", 4], dtype: "float32" },
      "input-node",
    )
    expect(result.status).toBe("fault")
    expect(host.runtimeDiagnostics()).toEqual([expect.objectContaining({
      occurrenceId: "inference:core.input@0.1.0:input-node",
      severity: "fatal",
      phase: "inference",
      packageId: "core.input",
      packageVersion: "0.1.0",
      nodeId: "input-node",
      message: expect.stringContaining("diagnostic Lua cause"),
    })])
  })
})
